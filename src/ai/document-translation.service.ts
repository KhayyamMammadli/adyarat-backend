import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiProviderName } from './ai.types';

const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
]);

@Injectable()
export class DocumentTranslationService {
  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiOrchestratorService,
  ) {}

  async translate(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<{
    bytes: Buffer;
    filename: string;
    mimeType: string;
    providers: AiProviderName[];
    sourceCharacters: number;
  }> {
    const maxBytes =
      this.config.get<number>('MAX_DOCUMENT_BYTES') ??
      20 * 1024 * 1024;

    if (bytes.length > maxBytes) {
      throw new Error(
        `Sənəd maksimum ${Math.floor(
          maxBytes / 1024 / 1024,
        )} MB ola bilər.`,
      );
    }

    const text = (
      await this.extract(bytes, mimeType, filename)
    ).trim();

    if (!text) {
      throw new Error(
        'Sənəddə seçilə bilən mətn tapılmadı. Skan PDF üçün OCR lazımdır.',
      );
    }

    const maxChars =
      this.config.get<number>('MAX_DOCUMENT_CHARS') ??
      500_000;

    if (text.length > maxChars) {
      throw new Error(
        `Sənəd maksimum ${maxChars} mətn simvolu ola bilər.`,
      );
    }

    const instruction =
      caption?.trim() ||
      `${
        this.config.get<string>(
          'DOCUMENT_DEFAULT_TARGET_LANGUAGE',
        ) ?? 'Azərbaycan dili'
      } dilinə tərcümə et`;

    const size =
      this.config.get<number>('DOCUMENT_CHUNK_CHARS') ??
      8000;

    const chunks = this.chunk(text, size);
    const output: string[] = [];
    const providers = new Set<AiProviderName>();

    for (const chunk of chunks) {
      const result = await this.ai.translate(
        chunk,
        instruction,
      );

      providers.add(result.provider);
      output.push(result.text);
    }

    const base = filename
      .replace(/\.[^.]+$/, '')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-');

    return {
      bytes: Buffer.from(
        output.join('\n\n'),
        'utf8',
      ),
      filename: `${
        base || 'document'
      }-tercume.txt`,
      mimeType: 'text/plain; charset=utf-8',
      providers: [...providers],
      sourceCharacters: text.length,
    };
  }

  private async extract(
    bytes: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const lower = filename.toLowerCase();

    if (
      mimeType === 'application/pdf' ||
      lower.endsWith('.pdf')
    ) {
      return (await pdfParse(bytes)).text;
    }

    if (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lower.endsWith('.docx')
    ) {
      return (
        await mammoth.extractRawText({
          buffer: bytes,
        })
      ).value;
    }

    if (
      TEXT_MIMES.has(mimeType) ||
      /\.(txt|md|csv|json|html?)$/.test(lower)
    ) {
      return bytes.toString('utf8');
    }

    throw new Error(
      'Dəstəklənən sənədlər: PDF, DOCX, TXT, MD, CSV, JSON və HTML.',
    );
  }

  private chunk(
    text: string,
    max: number,
  ): string[] {
    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > max) {
      let cut = remaining.lastIndexOf(
        '\n\n',
        max,
      );

      if (cut < max / 2) {
        cut = remaining.lastIndexOf(' ', max);
      }

      if (cut < 1) {
        cut = max;
      }

      parts.push(remaining.slice(0, cut));
      remaining = remaining
        .slice(cut)
        .trimStart();
    }

    if (remaining) {
      parts.push(remaining);
    }

    return parts;
  }
}