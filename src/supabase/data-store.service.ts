import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Contact,
  ContactState,
  ConversationMessage,
  CreateGenerationSegmentInput,
  CreateJobInput,
  EventStatus,
  GenerationJob,
  GenerationScenePlan,
  GenerationSegment,
  JobStage,
  JobStatus,
  MessageRecord,
  SegmentStatus,
  WebhookEvent,
} from '../common/domain';
import { SupabaseService } from './supabase.service';

type ContactPatch = Partial<
  Pick<
    Contact,
    | 'profileName'
    | 'state'
    | 'freeVideoUsed'
    | 'pendingImagePath'
    | 'pendingImageMime'
    | 'selectedVideoDurationSeconds'
    | 'pendingImagePaths'
    | 'pendingImageMimes'
  >
>;

type JobPatch = Partial<
  Pick<
    GenerationJob,
    | 'status'
    | 'outputStoragePath'
    | 'providerJobId'
    | 'errorMessage'
    | 'stage'
    | 'progressCompleted'
    | 'progressTotal'
    | 'scenePlan'
    | 'narrationText'
    | 'musicMood'
    | 'audioStoragePath'
    | 'errorCode'
  >
>;

type GenerationSegmentPatch = Partial<
  Pick<
    GenerationSegment,
    'status' | 'outputStoragePath' | 'providerJobId' | 'attempts' | 'errorCode' | 'errorMessage'
  >
>;

interface DbContact {
  id: string;
  wa_id: string;
  profile_name: string | null;
  state: ContactState;
  free_video_used: boolean;
  pending_image_path: string | null;
  pending_image_mime: string | null;
  selected_video_duration_seconds: 10 | 60;
  pending_image_paths: unknown;
  pending_image_mimes: unknown;
  created_at: string;
  updated_at: string;
}

interface DbWebhookEvent {
  id: string;
  event_key: string;
  payload: unknown;
  status: EventStatus;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DbGenerationJob {
  id: string;
  contact_id: string;
  status: JobStatus;
  provider: string;
  prompt: string;
  input_storage_path: string;
  input_mime_type: string;
  output_storage_path: string | null;
  provider_job_id: string | null;
  error_message: string | null;
