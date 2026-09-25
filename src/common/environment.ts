import {
  AiProviderName,
  AiRoutingProviderName,
} from '../ai/ai.types';

export type VideoProviderName = 'mock' | 'runway';

export interface Environment {
  NODE_ENV: string;
  PORT: number;

  META_GRAPH_API_VERSION: string;
  META_ACCESS_TOKEN?: string;
  META_PHONE_NUMBER_ID?: string;
  META_APP_SECRET?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;

  AI_DEFAULT_PROVIDER: AiRoutingProviderName;
  AI_PROVIDER_ORDER: AiProviderName[];
  AI_SYSTEM_PROMPT: string;
  AI_REQUEST_TIMEOUT_MS: number;
  AI_RETRY_ATTEMPTS: number;
  AI_MAX_REPLY_CHARS: number;

  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL: string;

  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OPENAI_TRANSCRIBE_MODEL: string;
  OPENAI_TTS_MODEL: string;
  OPENAI_TTS_VOICE: string;

  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL: string;

  VIDEO_PROVIDER: VideoProviderName;
  MOCK_VIDEO_PATH: string;

  RUNWAYML_API_SECRET?: string;
  RUNWAY_MODEL: string;
  RUNWAY_DURATION: number;
  RUNWAY_RATIO: string;

  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_BUCKET: string;

  WEBHOOK_POLL_MS: number;
  GENERATION_POLL_MS: number;

  MAX_IMAGE_BYTES: number;
  MAX_AUDIO_BYTES: number;
  MAX_DOCUMENT_BYTES: number;
  MAX_DOCUMENT_CHARS: number;
  DOCUMENT_CHUNK_CHARS: number;
  DOCUMENT_DEFAULT_TARGET_LANGUAGE: string;
  MAX_PROMPT_LENGTH: number;
}

const optional = (
  value: unknown,
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length
    ? normalized
    : undefined;
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  name: string,
): number => {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be positive`);
  }

  return parsed;
};

const aiProviderOrder = (
  value: unknown,
): AiProviderName[] => {
  const allowed: AiProviderName[] = [
    'gemini',
    'openai',
    'claude',
  ];

  const result = (
    optional(value) ??
    'gemini,openai,claude'
  )
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(
      (item): item is AiProviderName =>
        allowed.includes(item as AiProviderName),
    );

  return result.length
    ? [...new Set(result)]
    : allowed;
};

export function validateEnvironment(
  raw: Record<string, unknown>,
): Environment {
  const nodeEnv =
    optional(raw.NODE_ENV) ??
    'development';

  const videoProvider = (
    optional(raw.VIDEO_PROVIDER) ??
    'mock'
  ) as VideoProviderName;

  const legacyAi =
    optional(raw.AI_TEXT_PROVIDER);

  const aiDefaultProvider = (
    optional(raw.AI_DEFAULT_PROVIDER) ??
    (legacyAi === 'none' ? 'auto' : legacyAi) ??
    'auto'
  ) as AiRoutingProviderName;

  const runwayDuration = positiveInteger(
    raw.RUNWAY_DURATION,
    5,
    'RUNWAY_DURATION',
  );

  const maxPromptLength = positiveInteger(
    raw.MAX_PROMPT_LENGTH,
    1000,
    'MAX_PROMPT_LENGTH',
  );

  if (!['mock', 'runway'].includes(videoProvider)) {
    throw new Error(
      'VIDEO_PROVIDER must be mock or runway',
    );
  }

  if (
    ![
      'auto',
      'gemini',
      'openai',
      'claude',
    ].includes(aiDefaultProvider)
  ) {
    throw new Error(
      'AI_DEFAULT_PROVIDER must be auto, gemini, openai or claude',
    );
  }

  if (
    videoProvider === 'runway' &&
    !optional(raw.RUNWAYML_API_SECRET)
  ) {
    throw new Error(
      'RUNWAYML_API_SECRET is required when VIDEO_PROVIDER=runway',
    );
  }

  if (
    runwayDuration < 2 ||
    runwayDuration > 10
  ) {
    throw new Error(
      'RUNWAY_DURATION must be between 2 and 10 seconds',
    );
  }

  if (maxPromptLength > 1000) {
    throw new Error(
      'MAX_PROMPT_LENGTH cannot exceed 1000',
    );
  }

  if (nodeEnv === 'production') {
    for (const name of [
      'META_ACCESS_TOKEN',
      'META_PHONE_NUMBER_ID',
      'META_APP_SECRET',
      'META_WEBHOOK_VERIFY_TOKEN',
    ]) {
      if (!optional(raw[name])) {
        throw new Error(
          `${name} is required in production`,
        );
      }
    }
  }

  const hasSupabaseUrl = Boolean(
    optional(raw.SUPABASE_URL),
  );

  const hasSupabaseKey = Boolean(
    optional(raw.SUPABASE_SECRET_KEY) ??
      optional(raw.SUPABASE_SERVICE_ROLE_KEY),
  );

  if (hasSupabaseUrl !== hasSupabaseKey) {
    throw new Error(
      'SUPABASE_URL and a Supabase secret key must be configured together',
    );
  }

  return {
    NODE_ENV: nodeEnv,

    PORT: positiveInteger(
      raw.PORT,
      3000,
      'PORT',
    ),

    META_GRAPH_API_VERSION:
      optional(raw.META_GRAPH_API_VERSION) ??
      'v25.0',

    META_ACCESS_TOKEN:
      optional(raw.META_ACCESS_TOKEN),

    META_PHONE_NUMBER_ID:
      optional(raw.META_PHONE_NUMBER_ID),

    META_APP_SECRET:
      optional(raw.META_APP_SECRET),

    META_WEBHOOK_VERIFY_TOKEN:
      optional(raw.META_WEBHOOK_VERIFY_TOKEN),

    AI_DEFAULT_PROVIDER:
      aiDefaultProvider,

    AI_PROVIDER_ORDER:
      aiProviderOrder(raw.AI_PROVIDER_ORDER),

    AI_SYSTEM_PROMPT:
      optional(raw.AI_SYSTEM_PROMPT) ??
      'Sən AdYarat WhatsApp AI köməkçisisən. İstifadəçinin dilində aydın, faydalı və yığcam cavab ver.',

    AI_REQUEST_TIMEOUT_MS:
      positiveInteger(
        raw.AI_REQUEST_TIMEOUT_MS,
        60_000,
        'AI_REQUEST_TIMEOUT_MS',
      ),

    AI_RETRY_ATTEMPTS:
      positiveInteger(
        raw.AI_RETRY_ATTEMPTS,
        3,
        'AI_RETRY_ATTEMPTS',
      ),

    AI_MAX_REPLY_CHARS:
      positiveInteger(
        raw.AI_MAX_REPLY_CHARS,
        3500,
        'AI_MAX_REPLY_CHARS',
      ),

    GEMINI_API_KEY:
      optional(raw.GEMINI_API_KEY),

    GEMINI_MODEL:
      optional(raw.GEMINI_MODEL) ??
      'gemini-3.8-flash',

    GEMINI_FALLBACK_MODEL:
      optional(raw.GEMINI_FALLBACK_MODEL) ??
      'gemini-3.5-flash-lite',

    OPENAI_API_KEY:
      optional(raw.OPENAI_API_KEY),

    OPENAI_MODEL:
      optional(raw.OPENAI_MODEL) ??
      'gpt-5.6-terra',

    OPENAI_TRANSCRIBE_MODEL:
      optional(raw.OPENAI_TRANSCRIBE_MODEL) ??
      'gpt-transcribe',

    OPENAI_TTS_MODEL:
      optional(raw.OPENAI_TTS_MODEL) ??
      'gpt-4o-mini-tts',

    OPENAI_TTS_VOICE:
      optional(raw.OPENAI_TTS_VOICE) ??
      'marin',

    ANTHROPIC_API_KEY:
      optional(raw.ANTHROPIC_API_KEY),

    CLAUDE_MODEL:
      optional(raw.CLAUDE_MODEL) ??
      'claude-sonnet-5',

    VIDEO_PROVIDER:
      videoProvider,

    MOCK_VIDEO_PATH:
      optional(raw.MOCK_VIDEO_PATH) ??
      'assets/mock-video.mp4',

    RUNWAYML_API_SECRET:
      optional(raw.RUNWAYML_API_SECRET),

    RUNWAY_MODEL:
      optional(raw.RUNWAY_MODEL) ??
      'gen4.5',

    RUNWAY_DURATION:
      runwayDuration,

    RUNWAY_RATIO:
      optional(raw.RUNWAY_RATIO) ??
      '720:1280',

    SUPABASE_URL:
      optional(raw.SUPABASE_URL),

    SUPABASE_SECRET_KEY:
      optional(raw.SUPABASE_SECRET_KEY),

    SUPABASE_SERVICE_ROLE_KEY:
      optional(raw.SUPABASE_SERVICE_ROLE_KEY),

    SUPABASE_BUCKET:
      optional(raw.SUPABASE_BUCKET) ??
      'adyarat-media',

    WEBHOOK_POLL_MS:
      positiveInteger(
        raw.WEBHOOK_POLL_MS,
        1000,
        'WEBHOOK_POLL_MS',
      ),

    GENERATION_POLL_MS:
      positiveInteger(
        raw.GENERATION_POLL_MS,
        3000,
        'GENERATION_POLL_MS',
      ),

    MAX_IMAGE_BYTES:
      positiveInteger(
        raw.MAX_IMAGE_BYTES,
        5 * 1024 * 1024,
        'MAX_IMAGE_BYTES',
      ),

    MAX_AUDIO_BYTES:
      positiveInteger(
        raw.MAX_AUDIO_BYTES,
        25 * 1024 * 1024,
        'MAX_AUDIO_BYTES',
      ),

    MAX_DOCUMENT_BYTES:
      positiveInteger(
        raw.MAX_DOCUMENT_BYTES,
        20 * 1024 * 1024,
        'MAX_DOCUMENT_BYTES',
      ),

    MAX_DOCUMENT_CHARS:
      positiveInteger(
        raw.MAX_DOCUMENT_CHARS,
        500_000,
        'MAX_DOCUMENT_CHARS',
      ),

    DOCUMENT_CHUNK_CHARS:
      positiveInteger(
        raw.DOCUMENT_CHUNK_CHARS,
        8000,
        'DOCUMENT_CHUNK_CHARS',
      ),

    DOCUMENT_DEFAULT_TARGET_LANGUAGE:
      optional(
        raw.DOCUMENT_DEFAULT_TARGET_LANGUAGE,
      ) ??
      'Azərbaycan dili',

    MAX_PROMPT_LENGTH:
      maxPromptLength,
  };
}
