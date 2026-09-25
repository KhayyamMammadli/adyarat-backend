export type AiProviderName =
  | 'gemini'
  | 'openai'
  | 'claude';

export type AiRoutingProviderName =
  | 'auto'
  | AiProviderName;

export interface AiConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiTextRequest {
  text: string;
  provider?: AiProviderName;
  history?: AiConversationTurn[];
  systemInstruction?: string;
  maxOutputTokens?: number;
}

export interface AiTextResult {
  provider: AiProviderName;
  text: string;
}

export interface AudioTranscriptionResult
  extends AiTextResult {}

export interface VoiceTranslationResult {
  provider: AiProviderName;
  shouldTranslate: boolean;
  sourceText: string;
  targetLanguage?: string;
  translatedText?: string;
}

export interface SpeechSynthesisResult {
  provider: 'openai';
  bytes: Buffer;
  mimeType: 'audio/mpeg';
  filename: string;
}
