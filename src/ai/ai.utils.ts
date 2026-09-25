import { AiProviderName } from './ai.types';

const VIDEO_WORDS = [
  'video yarat',
  'video hazırla',
  'video hazirla',
  'reklam videosu',
  'videoya çevir',
  'videoya cevir',
];

export function parseProviderCommand(text: string): {
  provider?: AiProviderName;
  text: string;
} {
  const match = text
    .trim()
    .match(/^\/(gemini|chatgpt|openai|claude)\s+([\s\S]+)$/i);

  if (!match) return { text: text.trim() };

  const provider =
    match[1].toLowerCase() === 'chatgpt'
      ? 'openai'
      : match[1].toLowerCase();

  return {
    provider: provider as AiProviderName,
    text: match[2].trim(),
  };
}

export function isVideoIntent(text: string): boolean {
  const normalized = text.toLocaleLowerCase('az-AZ');

  return VIDEO_WORDS.some((word) => normalized.includes(word));
}

export function providerLabel(provider: AiProviderName): string {
  return provider === 'openai'
    ? 'ChatGPT'
    : provider === 'claude'
      ? 'Claude'
      : 'Gemini';
}

export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);

    if (cut < maxLength * 0.5) {
      cut = remaining.lastIndexOf(' ', maxLength);
    }

    if (cut < 1) {
      cut = maxLength;
    }

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}