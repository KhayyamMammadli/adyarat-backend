export type ContactState =
  | 'new'
  | 'awaiting_prompt'
  | 'awaiting_ad_copy_brief'
  | 'awaiting_voice_ad_brief'
  | 'awaiting_support_message'
  | 'processing';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type MessageDirection = 'inbound' | 'outbound';

export interface Contact {
  id: string;
  waId: string;
  profileName?: string;
  state: ContactState;
  freeVideoUsed?: boolean;
  pendingImagePath?: string;
  pendingImageMime?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  id: string;
  eventKey: string;
  payload: unknown;
  status: EventStatus;
  attempts: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationJob {
  id: string;
  contactId: string;
  status: JobStatus;
  provider: string;
  prompt: string;
  inputStoragePath: string;
  inputMimeType: string;
  outputStoragePath?: string;
  providerJobId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput {
  contactId: string;
  provider: string;
  prompt: string;
  inputStoragePath: string;
  inputMimeType: string;
}

export interface MessageRecord {
  waMessageId: string;
  contactId: string;
  direction: MessageDirection;
  type: string;
  content: unknown;
  status: string;
}

export interface ConversationMessage extends MessageRecord {
  createdAt: string;
}
