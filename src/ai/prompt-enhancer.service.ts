import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PromptEnhancerService {
  private readonly logger = new Logger(PromptEnhancerService.name);
  private readonly provider: string;
  private readonly client?: GoogleGenAI;

  constructor(private readonly config: ConfigService) {
    this.provider = this.config.get<string>('AI_TEXT_PROVIDER') ?? 'none';

    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (this.provider === 'gemini' && apiKey) {
      this.client = new GoogleGenAI({ apiKey });
      this.logger.log('Gemini prompt enhancement enabled');
      return;
    }

    this.logger.log('AI prompt enhancement disabled');
  }

  async enhance(userPrompt: string): Promise<string> {
    if (this.provider !== 'gemini' || !this.client) {
      return userPrompt;
    }

    try {
      const model = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-3.8-flash';
      const duration = this.config.get<number>('RUNWAY_DURATION') ?? 5;

      const interaction = await this.client.interactions.create({
        model,
        store: false,
        input: userPrompt,
        system_instruction: [
          'Convert the user request into one professional English image-to-video prompt for Runway.',
          'Preserve the original intent and the visible product.',
          'Do not invent brand names, logos, readable text, people, or additional products unless explicitly requested.',
          'Describe natural subject motion, realistic camera movement, lighting, atmosphere, and premium commercial quality.',
          `The result must be suitable for a ${duration}-second vertical 9:16 advertisement in one continuous shot.`,
          'Return only the final English prompt without explanations, headings, quotation marks, or Markdown.',
        ].join(' '),
      });

      const enhancedPrompt = interaction.output_text?.trim();
      if (!enhancedPrompt) {
        this.logger.warn('Gemini returned an empty prompt; using the original prompt');
        return userPrompt;
      }

      const maxLength = this.config.get<number>('MAX_PROMPT_LENGTH') ?? 1000;
      return enhancedPrompt.slice(0, maxLength);
    } catch (error: unknown) {
      this.logger.warn(
        `Gemini prompt enhancement failed; using the original prompt: ${String(error)}`,
      );
      return userPrompt;
    }
  }
}
