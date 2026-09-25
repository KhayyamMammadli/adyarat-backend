import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderName,
  AiTextRequest,
  AiTextResult,
  AudioTranscriptionResult,
} from './ai.types';

class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);

  constructor(private readonly config: ConfigService) {}

  async answer(request: AiTextRequest): Promise<AiTextResult> {
    const providers = request.provider
      ? [request.provider]
      : this.providerOrder();

    const errors: string[] = [];

    for (const provider of providers) {
      if (!this.isConfigured(provider)) {
        errors.push(`${provider}: API açarı yoxdur`);
        continue;
      }

      try {
        const text = await this.withRetry(() =>
          this.callProvider(provider, request),
        );

        if (!text.trim()) {
          throw new Error('AI boş cavab qaytardı');
        }

        return {
          provider,
          text: text.trim(),
        };
      } catch (error) {
        const message = this.errorMessage(error);

        errors.push(`${provider}: ${message}`);
        this.logger.warn(`${provider} request failed: ${message}`);
      }
    }

    throw new Error(
      errors.length
        ? `AI cavabı alınmadı. ${errors.join(' | ')}`
        : 'Heç bir AI provayderi sazlanmayıb.',
    );
  }

  async enhanceVideoPrompt(prompt: string): Promise<string> {
    try {
      const result = await this.answer({
        text: prompt,
        maxOutputTokens: 350,
        systemInstruction:
          'Convert the Azerbaijani/Turkish request into one concise English image-to-video advertising prompt. Preserve product, action, camera and mood. Return only the prompt.',
      });

      return result.text;
    } catch (error) {
      this.logger.warn(
        `Video prompt enhancement skipped: ${this.errorMessage(error)}`,
      );

      return prompt;
    }
  }

  async translate(
    text: string,
    instruction: string,
    provider?: AiProviderName,
  ): Promise<AiTextResult> {
    return this.answer({
      text,
      provider,
      maxOutputTokens: 8000,
      systemInstruction: `Translate this document segment according to: ${instruction}. Preserve headings, paragraphs, lists, names, numbers and meaning. Return only the translation.`,
    });
  }

  async transcribe(
    bytes: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<AudioTranscriptionResult> {
    const errors: string[] = [];

    if (this.isConfigured('openai')) {
      try {
        return {
          provider: 'openai',
          text: await this.withRetry(() =>
            this.transcribeWithOpenAi(
              bytes,
              mimeType,
              filename,
            ),
          ),
        };
      } catch (error) {
        errors.push(`openai: ${this.errorMessage(error)}`);
      }
    }

    if (this.isConfigured('gemini')) {
      try {
        return {
          provider: 'gemini',
          text: await this.withRetry(() =>
            this.transcribeWithGemini(bytes, mimeType),
          ),
        };
      } catch (error) {
        errors.push(`gemini: ${this.errorMessage(error)}`);
      }
    }

    throw new Error(
      errors.length
        ? `Səs mətnə çevrilmədi. ${errors.join(' | ')}`
        : 'Səs üçün OPENAI_API_KEY və ya GEMINI_API_KEY lazımdır.',
    );
  }

  private callProvider(
    provider: AiProviderName,
    request: AiTextRequest,
  ): Promise<string> {
    if (provider === 'gemini') {
      return this.callGemini(request);
    }

    if (provider === 'openai') {
      return this.callOpenAi(request);
    }

    return this.callClaude(request);
  }

  private async callGemini(
    request: AiTextRequest,
  ): Promise<string> {
    const models = [
      this.config.get<string>('GEMINI_MODEL') ??
        'gemini-3.8-flash',
      this.config.get<string>('GEMINI_FALLBACK_MODEL') ??
        'gemini-3.5-flash-lite',
    ].filter(
      (model, index, list) => list.indexOf(model) === index,
    );

    const client = new GoogleGenAI({
      apiKey: this.requireConfig('GEMINI_API_KEY'),
    });

    let lastError: unknown;

    for (const model of models) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: this.conversationText(request),
          config: {
            systemInstruction:
              request.systemInstruction ??
              this.defaultSystemInstruction(),
            maxOutputTokens:
              request.maxOutputTokens ?? 1400,
          },
        });

        return response.text ?? '';
      } catch (error) {
        lastError = error;

        if (!this.isTransient(error)) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error('Gemini cavab vermədi');
  }

  private async callOpenAi(
    request: AiTextRequest,
  ): Promise<string> {
    const response = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.requireConfig(
            'OPENAI_API_KEY',
          )}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model:
            this.config.get<string>('OPENAI_MODEL') ??
            'gpt-5.6-terra',
          instructions:
            request.systemInstruction ??
            this.defaultSystemInstruction(),
          input: this.conversationText(request),
          max_output_tokens:
            request.maxOutputTokens ?? 1400,
        }),
        signal: AbortSignal.timeout(
          this.requestTimeout(),
        ),
      },
    );

    const body = (await response.json()) as {
      error?: {
        message?: string;
      };
      output_text?: string;
      output?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ??
          `OpenAI request failed (${response.status})`,
        response.status,
      );
    }

    return (
      body.output_text ??
      (body.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('\n')
    );
  }

  private async callClaude(
    request: AiTextRequest,
  ): Promise<string> {
    const response = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': this.requireConfig(
            'ANTHROPIC_API_KEY',
          ),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model:
            this.config.get<string>('CLAUDE_MODEL') ??
            'claude-sonnet-5',
          max_tokens:
            request.maxOutputTokens ?? 1400,
          system:
            request.systemInstruction ??
            this.defaultSystemInstruction(),
          messages: [
            {
              role: 'user',
              content: this.conversationText(request),
            },
          ],
        }),
        signal: AbortSignal.timeout(
          this.requestTimeout(),
        ),
      },
    );

    const body = (await response.json()) as {
      error?: {
        message?: string;
      };
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    };

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ??
          `Claude request failed (${response.status})`,
        response.status,
      );
    }

    return (body.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
  }

  private async transcribeWithOpenAi(
    bytes: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();

    form.append(
      'file',
      new Blob(
        [Uint8Array.from(bytes)],
        { type: mimeType },
      ),
      filename,
    );

    form.append(
      'model',
      this.config.get<string>(
        'OPENAI_TRANSCRIBE_MODEL',
      ) ?? 'gpt-transcribe',
    );

    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.requireConfig(
            'OPENAI_API_KEY',
          )}`,
        },
        body: form,
        signal: AbortSignal.timeout(
          this.requestTimeout(),
        ),
      },
    );

    const body = (await response.json()) as {
      text?: string;
      error?: {
        message?: string;
      };
    };

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ??
          `OpenAI transcription failed (${response.status})`,
        response.status,
      );
    }

    if (!body.text) {
      throw new Error('Transkripsiya boş qaytarıldı');
    }

    return body.text.trim();
  }

  private async transcribeWithGemini(
    bytes: Buffer,
    mimeType: string,
  ): Promise<string> {
    const client = new GoogleGenAI({
      apiKey: this.requireConfig('GEMINI_API_KEY'),
    });

    const response = await client.models.generateContent({
      model:
        this.config.get<string>('GEMINI_MODEL') ??
        'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Səs yazısını olduğu dildə dəqiq mətnə çevir. Yalnız mətni qaytar.',
            },
            {
              inlineData: {
                mimeType,
                data: bytes.toString('base64'),
              },
            },
          ],
        },
      ],
    });

    if (!response.text?.trim()) {
      throw new Error(
        'Gemini boş transkripsiya qaytardı',
      );
    }

    return response.text.trim();
  }

  private providerOrder(): AiProviderName[] {
    return (
      this.config.get<AiProviderName[]>(
        'AI_PROVIDER_ORDER',
      ) ?? ['gemini', 'openai', 'claude']
    );
  }

  private isConfigured(
    provider: AiProviderName,
  ): boolean {
    const key =
      provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : provider === 'openai'
          ? 'OPENAI_API_KEY'
          : 'ANTHROPIC_API_KEY';

    return Boolean(this.config.get<string>(key));
  }

  private conversationText(
    request: AiTextRequest,
  ): string {
    const history = (request.history ?? [])
      .slice(-8)
      .map(
        (turn) =>
          `${
            turn.role === 'user'
              ? 'İstifadəçi'
              : 'Köməkçi'
          }: ${turn.text}`,
      )
      .join('\n');

    return history
      ? `${history}\nİstifadəçi: ${request.text}`
      : request.text;
  }

  private defaultSystemInstruction(): string {
    return (
      this.config.get<string>('AI_SYSTEM_PROMPT') ??
      'Sən AdYarat WhatsApp AI köməkçisisən. İstifadəçinin dilində aydın, faydalı və yığcam cavab ver.'
    );
  }

  private requestTimeout(): number {
    return (
      this.config.get<number>(
        'AI_REQUEST_TIMEOUT_MS',
      ) ?? 60_000
    );
  }

  private requireConfig(name: string): string {
    const value = this.config.get<string>(name);

    if (!value) {
      throw new Error(
        `${name} konfiqurasiya edilməyib`,
      );
    }

    return value;
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const attempts =
      this.config.get<number>('AI_RETRY_ATTEMPTS') ?? 3;

    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < attempts;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (
          !this.isTransient(error) ||
          attempt === attempts - 1
        ) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 800 * 2 ** attempt),
        );
      }
    }

    throw lastError;
  }

  private isTransient(error: unknown): boolean {
    const status =
      error instanceof AiProviderError
        ? error.status
        : typeof error === 'object' &&
            error !== null &&
            'status' in error
          ? Number(
              (error as { status?: unknown }).status,
            )
          : undefined;

    return (
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      /429|5\d\d|high demand|unavailable|timeout/i.test(
        this.errorMessage(error),
      )
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : String(error);
  }
}