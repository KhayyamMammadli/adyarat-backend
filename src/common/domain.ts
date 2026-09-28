export type ContactState =
  | 'new'
  | 'awaiting_prompt'
  | 'awaiting_ad_copy_brief'
  | 'awaiting_voice_ad_brief'
  | 'awaiting_support_message'
  | 'awaiting_video_duration'
  | 'awaiting_long_video_images'
  | 'awaiting_long_video_brief'
  | 'processing';

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export type EventStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type MessageDirection =
  | 'inbound'
  | 'outbound';

export type VideoMode =
  | 'single'
  | 'long';

export type VideoDurationSeconds =
  | 10
  | 20
  | 30
  | 40
  | 50
  | 60
  | 70
  | 80
  | 90
  | 100
  | 110
  | 120
  | 130
  | 140
  | 150
  | 160
  | 170
  | 180;

export type JobStage =
  | 'queued'
  | 'planning'
  | 'generating_scenes'
  | 'composing'
  | 'narrating'
  | 'completed'
  | 'failed';

export type SegmentStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export type SceneTransition =
  | 'cut'
  | 'fade'
  | 'crossfade'
  | 'zoom'
  | 'slide';

export interface Contact {
  id: string;

  waId: string;

  profileName?: string;

  state: ContactState;

  freeVideoUsed?: boolean;

  pendingImagePath?: string;

  pendingImageMime?: string;

  selectedVideoDurationSeconds?: VideoDurationSeconds;

  pendingImagePaths?: string[];

  pendingImageMimes?: string[];

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

export interface GenerationScenePlan {
  sceneIndex: number;

  prompt: string;

  narrationText?: string;

  overlayText?: string;

  transition: SceneTransition;

  durationSeconds: number;

  sourceImageIndex: number;
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

  videoMode?: VideoMode;

  targetDurationSeconds?: VideoDurationSeconds;

  sceneCount?: number;

  stage?: JobStage;

  progressCompleted?: number;

  progressTotal?: number;

  sourceImagePaths?: string[];

  sourceImageMimes?: string[];

  scenePlan?: GenerationScenePlan[];

  narrationText?: string;

  musicMood?: string;

  audioStoragePath?: string;

  errorCode?: string;
}

export interface CreateJobInput {
  contactId: string;

  provider: string;

  prompt: string;

  inputStoragePath: string;

  inputMimeType: string;

  videoMode?: VideoMode;

  targetDurationSeconds?: VideoDurationSeconds;

  sceneCount?: number;

  sourceImagePaths?: string[];

  sourceImageMimes?: string[];

  scenePlan?: GenerationScenePlan[];

  narrationText?: string;

  musicMood?: string;
}

export interface GenerationSegment {
  id: string;

  jobId: string;

  sceneIndex: number;

  status: SegmentStatus;

  prompt: string;

  narrationText?: string;

  overlayText?: string;

  transition: SceneTransition;

  durationSeconds: number;

  inputStoragePath: string;

  inputMimeType: string;

  outputStoragePath?: string;

  providerJobId?: string;

  attempts: number;

  errorCode?: string;

  errorMessage?: string;

  createdAt: string;

  updatedAt: string;
}

export interface CreateGenerationSegmentInput {
  jobId: string;

  sceneIndex: number;

  prompt: string;

  narrationText?: string;

  overlayText?: string;

  transition: SceneTransition;

  durationSeconds: number;

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

export interface ConversationMessage
  extends MessageRecord {
  createdAt: string;
}
