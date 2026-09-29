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
  VideoDurationSeconds,
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
    | 'status'
    | 'outputStoragePath'
    | 'providerJobId'
    | 'attempts'
    | 'errorCode'
    | 'errorMessage'
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
  selected_video_duration_seconds: VideoDurationSeconds;
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
  created_at: string;
  updated_at: string;

  video_mode: 'single' | 'long';

  target_duration_seconds: VideoDurationSeconds;

  scene_count: number;

  stage: JobStage;

  progress_completed: number;

  progress_total: number;

  source_image_paths: unknown;

  source_image_mimes: unknown;

  scene_plan: unknown;

  narration_text: string | null;

  music_mood: string | null;

  audio_storage_path: string | null;

  error_code: string | null;
}

interface DbGenerationSegment {
  id: string;
  job_id: string;
  scene_index: number;
  status: SegmentStatus;
  prompt: string;
  narration_text: string | null;
  overlay_text: string | null;
  transition: GenerationSegment['transition'];
  duration_seconds: number;
  input_storage_path: string;
  input_mime_type: string;
  output_storage_path: string | null;
  provider_job_id: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DbMessage {
  wa_message_id: string;
  contact_id: string;
  direction: MessageRecord['direction'];
  type: string;
  content: unknown;
  status: string;
  created_at: string;
}


interface AdminEventRecord {
  id: string;
  contactId?: string;
  waId?: string;
  profileName?: string;
  eventType: string;
  prompt?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface RecordAdminEventInput {
  contactId?: string;
  waId?: string;
  profileName?: string;
  eventType: string;
  prompt?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class DataStoreService {
  private readonly contacts = new Map<string, Contact>();
  private readonly contactIdsByWaId = new Map<string, string>();

  private readonly webhookEvents = new Map<
    string,
    WebhookEvent
  >();

  private readonly webhookEventIdsByKey = new Map<
    string,
    string
  >();

  private readonly jobs = new Map<
    string,
    GenerationJob
  >();

  private readonly messages = new Map<
    string,
    ConversationMessage
  >();

  private readonly segments = new Map<
    string,
    GenerationSegment
  >();

  private readonly adminEvents = new Map<
    string,
    AdminEventRecord
  >();

  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  persistenceMode(): 'supabase' | 'memory' {
    return this.supabase.isEnabled()
      ? 'supabase'
      : 'memory';
  }

  async getOrCreateContact(
    waId: string,
    profileName?: string,
  ): Promise<Contact> {
    if (!this.supabase.isEnabled()) {
      const existingId =
        this.contactIdsByWaId.get(waId);

      if (existingId) {
        const existing =
          this.contacts.get(existingId);

        if (!existing) {
          throw new Error(
            'Contact index is inconsistent',
          );
        }

        if (
          profileName &&
          profileName !== existing.profileName
        ) {
          return this.updateContact(
            existing.id,
            {
              profileName,
            },
          );
        }

        return {
          ...existing,
        };
      }

      const now =
        new Date().toISOString();

      const contact: Contact = {
        id: randomUUID(),
        waId,
        profileName,
        state: 'new',
        freeVideoUsed: false,
        selectedVideoDurationSeconds: 10,
        pendingImagePaths: [],
        pendingImageMimes: [],
        createdAt: now,
        updatedAt: now,
      };

      this.contacts.set(
        contact.id,
        contact,
      );

      this.contactIdsByWaId.set(
        waId,
        contact.id,
      );

      return {
        ...contact,
      };
    }

    const existing =
      await this.getContactByWaId(
        waId,
      );

    if (existing) {
      if (
        profileName &&
        profileName !== existing.profileName
      ) {
        return this.updateContact(
          existing.id,
          {
            profileName,
          },
        );
      }

      return existing;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('wa_contacts')
        .insert({
          wa_id: waId,
          profile_name:
            profileName ?? null,
          state: 'new',
        })
        .select('*')
        .single();

    if (error) {
      const concurrent =
        await this.getContactByWaId(
          waId,
        );

      if (concurrent) {
        return concurrent;
      }

      throw error;
    }

    return this.mapContact(
      data as DbContact,
    );
  }

  async getContactById(
    id: string,
  ): Promise<Contact | undefined> {
    if (!this.supabase.isEnabled()) {
      const contact =
        this.contacts.get(id);

      return contact
        ? { ...contact }
        : undefined;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('wa_contacts')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapContact(
          data as DbContact,
        )
      : undefined;
  }

  async getContactByWaId(
    waId: string,
  ): Promise<Contact | undefined> {
    if (!this.supabase.isEnabled()) {
      const id =
        this.contactIdsByWaId.get(
          waId,
        );

      if (!id) {
        return undefined;
      }

      const contact =
        this.contacts.get(id);

      return contact
        ? { ...contact }
        : undefined;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('wa_contacts')
        .select('*')
        .eq('wa_id', waId)
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapContact(
          data as DbContact,
        )
      : undefined;
  }

  async updateContact(
    id: string,
    patch: ContactPatch,
  ): Promise<Contact> {
    if (!this.supabase.isEnabled()) {
      const current =
        this.contacts.get(id);

      if (!current) {
        throw new Error(
          `Contact not found: ${id}`,
        );
      }

      const next: Contact = {
        ...current,
        ...patch,
        updatedAt:
          new Date().toISOString(),
      };

      this.contacts.set(
        id,
        next,
      );

      return {
        ...next,
      };
    }

    const update: Record<
      string,
      unknown
    > = {
      updated_at:
        new Date().toISOString(),
    };

    if (
      this.hasOwn(
        patch,
        'profileName',
      )
    ) {
      update.profile_name =
        patch.profileName ?? null;
    }

    if (
      this.hasOwn(
        patch,
        'state',
      )
    ) {
      update.state =
        patch.state;
    }

    if (
      this.hasOwn(
        patch,
        'freeVideoUsed',
      )
    ) {
      update.free_video_used =
        patch.freeVideoUsed ??
        false;
    }

    if (
      this.hasOwn(
        patch,
        'pendingImagePath',
      )
    ) {
      update.pending_image_path =
        patch.pendingImagePath ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'pendingImageMime',
      )
    ) {
      update.pending_image_mime =
        patch.pendingImageMime ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'selectedVideoDurationSeconds',
      )
    ) {
      update.selected_video_duration_seconds =
        patch.selectedVideoDurationSeconds ??
        10;
    }

    if (
      this.hasOwn(
        patch,
        'pendingImagePaths',
      )
    ) {
      update.pending_image_paths =
        patch.pendingImagePaths ??
        [];
    }

    if (
      this.hasOwn(
        patch,
        'pendingImageMimes',
      )
    ) {
      update.pending_image_mimes =
        patch.pendingImageMimes ??
        [];
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('wa_contacts')
        .update(update)
        .eq('id', id)
        .select('*')
        .single();

    if (error) {
      throw error;
    }

    return this.mapContact(
      data as DbContact,
    );
  }

  async enqueueWebhook(
    eventKey: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      if (
        this.webhookEventIdsByKey.has(
          eventKey,
        )
      ) {
        return;
      }

      const now =
        new Date().toISOString();

      const event: WebhookEvent = {
        id: randomUUID(),
        eventKey,
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };

      this.webhookEvents.set(
        event.id,
        event,
      );

      this.webhookEventIdsByKey.set(
        eventKey,
        event.id,
      );

      return;
    }

    const {
      error,
    } =
      await this.supabase.client
        .from('webhook_events')
        .upsert(
          {
            event_key: eventKey,
            payload,
            status: 'pending',
            attempts: 0,
          },
          {
            onConflict: 'event_key',
            ignoreDuplicates: true,
          },
        );

    if (error) {
      throw error;
    }
  }

  async claimNextWebhook():
    Promise<
      WebhookEvent | undefined
    > {
    if (!this.supabase.isEnabled()) {
      const next = [
        ...this.webhookEvents.values(),
      ]
        .filter(
          (event) =>
            event.status ===
            'pending',
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(
              b.createdAt,
            ),
        )[0];

      if (!next) {
        return undefined;
      }

      const claimed: WebhookEvent = {
        ...next,
        status: 'processing',
        attempts:
          next.attempts + 1,
        updatedAt:
          new Date().toISOString(),
      };

      this.webhookEvents.set(
        claimed.id,
        claimed,
      );

      return {
        ...claimed,
      };
    }

    const {
      data: candidate,
      error: selectError,
    } =
      await this.supabase.client
        .from('webhook_events')
        .select('*')
        .eq(
          'status',
          'pending',
        )
        .order(
          'created_at',
          {
            ascending: true,
          },
        )
        .limit(1)
        .maybeSingle();

    if (selectError) {
      throw selectError;
    }

    if (!candidate) {
      return undefined;
    }

    const row =
      candidate as DbWebhookEvent;

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('webhook_events')
        .update({
          status: 'processing',
          attempts:
            row.attempts + 1,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          row.id,
        )
        .eq(
          'status',
          'pending',
        )
        .select('*')
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapWebhookEvent(
          data as DbWebhookEvent,
        )
      : undefined;
  }

  async completeWebhook(
    id: string,
  ): Promise<void> {
    await this.setWebhookState(
      id,
      'completed',
    );
  }

  async failWebhook(
    id: string,
    errorMessage: string,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      const event =
        this.webhookEvents.get(id);

      if (!event) {
        return;
      }

      this.webhookEvents.set(
        id,
        {
          ...event,
          status: 'failed',
          errorMessage,
          updatedAt:
            new Date().toISOString(),
        },
      );

      return;
    }

    const {
      error,
    } =
      await this.supabase.client
        .from('webhook_events')
        .update({
          status: 'failed',
          error_message:
            errorMessage.slice(
              0,
              2000,
            ),
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          id,
        );

    if (error) {
      throw error;
    }
  }

  async recordMessage(
    message: MessageRecord,
  ): Promise<boolean> {
    if (!this.supabase.isEnabled()) {
      if (
        this.messages.has(
          message.waMessageId,
        )
      ) {
        return false;
      }

      const record:
        ConversationMessage = {
        ...message,
        createdAt:
          new Date().toISOString(),
      };

      this.messages.set(
        message.waMessageId,
        record,
      );

      return true;
    }

    const {
      error,
    } =
      await this.supabase.client
        .from('wa_messages')
        .insert({
          wa_message_id:
            message.waMessageId,
          contact_id:
            message.contactId,
          direction:
            message.direction,
          type:
            message.type,
          content:
            message.content,
          status:
            message.status,
        });

    if (!error) {
      return true;
    }

    if (
      error.code === '23505'
    ) {
      return false;
    }

    throw error;
  }

  async updateMessageStatus(
    waMessageId: string,
    status: string,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      const message =
        this.messages.get(
          waMessageId,
        );

      if (!message) {
        return;
      }

      this.messages.set(
        waMessageId,
        {
          ...message,
          status,
        },
      );

      return;
    }

    const {
      error,
    } =
      await this.supabase.client
        .from('wa_messages')
        .update({
          status,
        })
        .eq(
          'wa_message_id',
          waMessageId,
        );

    if (error) {
      throw error;
    }
  }

  async getRecentMessages(
    contactId: string,
    limit = 12,
  ): Promise<
    ConversationMessage[]
  > {
    if (!this.supabase.isEnabled()) {
      return [
        ...this.messages.values(),
      ]
        .filter(
          (message) =>
            message.contactId ===
            contactId,
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(
              b.createdAt,
            ),
        )
        .slice(-limit)
        .map(
          (message) => ({
            ...message,
          }),
        );
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('wa_messages')
        .select(
          'wa_message_id, contact_id, direction, type, content, status, created_at',
        )
        .eq(
          'contact_id',
          contactId,
        )
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(limit);

    if (error) {
      throw error;
    }

    return (
      (
        data ?? []
      ) as DbMessage[]
    )
      .map(
        (row) =>
          this.mapMessage(row),
      )
      .reverse();
  }

  async createJob(
  input: CreateJobInput,
): Promise<GenerationJob> {
  const now =
    new Date().toISOString();

  const sourceImagePaths =
    input.sourceImagePaths?.length
      ? input.sourceImagePaths
      : [
          input.inputStoragePath,
        ];

  const sourceImageMimes =
    input.sourceImageMimes?.length
      ? input.sourceImageMimes
      : [
          input.inputMimeType,
        ];

  const targetDurationSeconds =
    input.targetDurationSeconds ?? 10;

  const sceneCount =
    input.sceneCount ??
    Math.max(
      1,
      Math.ceil(
        targetDurationSeconds / 10,
      ),
    );

  const videoMode =
    targetDurationSeconds > 10
      ? 'long'
      : 'single';

  if (!this.supabase.isEnabled()) {
    const job: GenerationJob = {
      id: randomUUID(),

      contactId:
        input.contactId,

      status:
        'queued',

      provider:
        input.provider,

      prompt:
        input.prompt,

      inputStoragePath:
        input.inputStoragePath,

      inputMimeType:
        input.inputMimeType,

      createdAt:
        now,

      updatedAt:
        now,

      videoMode,

      targetDurationSeconds,

      sceneCount,

      stage:
        'queued',

      progressCompleted:
        0,

      progressTotal:
        sceneCount,

      sourceImagePaths,

      sourceImageMimes,

      scenePlan:
        input.scenePlan,

      narrationText:
        input.narrationText,

      musicMood:
        input.musicMood,
    };

    this.jobs.set(
      job.id,
      job,
    );

    return {
      ...job,
    };
  }

  const {
    data,
    error,
  } =
    await this.supabase.client
      .from(
        'generation_jobs',
      )
      .insert({
        contact_id:
          input.contactId,

        status:
          'queued',

        provider:
          input.provider,

        prompt:
          input.prompt,

        input_storage_path:
          input.inputStoragePath,

        input_mime_type:
          input.inputMimeType,

        video_mode:
          videoMode,

        target_duration_seconds:
          targetDurationSeconds,

        scene_count:
          sceneCount,

        stage:
          'queued',

        progress_completed:
          0,

        progress_total:
          sceneCount,

        source_image_paths:
          sourceImagePaths,

        source_image_mimes:
          sourceImageMimes,

        scene_plan:
          input.scenePlan ??
          null,

        narration_text:
          input.narrationText ??
          null,

        music_mood:
          input.musicMood ??
          null,
      })
      .select('*')
      .single();

  if (error) {
    throw error;
  }

  return this.mapJob(
    data as DbGenerationJob,
  );
}

  async countRecentJobs(
  contactId: string,
  since: Date,
): Promise<number> {
  const sinceIso =
    since.toISOString();

  if (!this.supabase.isEnabled()) {
    return Array.from(
      this.jobs.values(),
    ).filter((job) => {
      return (
        job.contactId === contactId &&
        new Date(job.createdAt).getTime() >=
          since.getTime()
      );
    }).length;
  }

  const {
    count,
    error,
  } =
    await this.supabase.client
      .from('generation_jobs')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq(
        'contact_id',
        contactId,
      )
      .gte(
        'created_at',
        sinceIso,
      );

  if (error) {
    throw error;
  }

  return count ?? 0;
}

  async hasActiveJob(
    contactId: string,
  ): Promise<boolean> {
    if (!this.supabase.isEnabled()) {
      return [
        ...this.jobs.values(),
      ].some(
        (job) =>
          job.contactId ===
            contactId &&
          (
            job.status ===
              'queued' ||
            job.status ===
              'processing'
          ),
      );
    }

    const {
      count,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .select(
          'id',
          {
            count: 'exact',
            head: true,
          },
        )
        .eq(
          'contact_id',
          contactId,
        )
        .in(
          'status',
          [
            'queued',
            'processing',
          ],
        );

    if (error) {
      throw error;
    }

    return (
      count ?? 0
    ) > 0;
  }

  async claimNextJob():
    Promise<
      GenerationJob | undefined
    > {
    if (!this.supabase.isEnabled()) {
      const next = [
        ...this.jobs.values(),
      ]
        .filter(
          (job) =>
            job.status ===
            'queued',
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(
              b.createdAt,
            ),
        )[0];

      if (!next) {
        return undefined;
      }

      const claimed:
        GenerationJob = {
        ...next,
        status: 'processing',
        stage:
          next.stage ===
          'queued'
            ? 'generating_scenes'
            : next.stage,
        updatedAt:
          new Date().toISOString(),
      };

      this.jobs.set(
        claimed.id,
        claimed,
      );

      return {
        ...claimed,
      };
    }

    const {
      data: candidate,
      error: selectError,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .select('*')
        .eq(
          'status',
          'queued',
        )
        .order(
          'created_at',
          {
            ascending: true,
          },
        )
        .limit(1)
        .maybeSingle();

    if (selectError) {
      throw selectError;
    }

    if (!candidate) {
      return undefined;
    }

    const row =
      candidate as DbGenerationJob;

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .update({
          status:
            'processing',
          stage:
            row.stage ===
            'queued'
              ? 'generating_scenes'
              : row.stage,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          row.id,
        )
        .eq(
          'status',
          'queued',
        )
        .select('*')
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapJob(
          data as DbGenerationJob,
        )
      : undefined;
  }

  async updateJob(
    id: string,
    patch: JobPatch,
  ): Promise<GenerationJob> {
    if (!this.supabase.isEnabled()) {
      const current =
        this.jobs.get(id);

      if (!current) {
        throw new Error(
          `Generation job not found: ${id}`,
        );
      }

      const next:
        GenerationJob = {
        ...current,
        ...patch,
        updatedAt:
          new Date().toISOString(),
      };

      this.jobs.set(
        id,
        next,
      );

      return {
        ...next,
      };
    }

    const update: Record<
      string,
      unknown
    > = {
      updated_at:
        new Date().toISOString(),
    };

    if (
      this.hasOwn(
        patch,
        'status',
      )
    ) {
      update.status =
        patch.status;
    }

    if (
      this.hasOwn(
        patch,
        'outputStoragePath',
      )
    ) {
      update.output_storage_path =
        patch.outputStoragePath ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'providerJobId',
      )
    ) {
      update.provider_job_id =
        patch.providerJobId ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'errorMessage',
      )
    ) {
      update.error_message =
        patch.errorMessage ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'stage',
      )
    ) {
      update.stage =
        patch.stage;
    }

    if (
      this.hasOwn(
        patch,
        'progressCompleted',
      )
    ) {
      update.progress_completed =
        patch.progressCompleted;
    }

    if (
      this.hasOwn(
        patch,
        'progressTotal',
      )
    ) {
      update.progress_total =
        patch.progressTotal;
    }

    if (
      this.hasOwn(
        patch,
        'scenePlan',
      )
    ) {
      update.scene_plan =
        patch.scenePlan ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'narrationText',
      )
    ) {
      update.narration_text =
        patch.narrationText ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'musicMood',
      )
    ) {
      update.music_mood =
        patch.musicMood ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'audioStoragePath',
      )
    ) {
      update.audio_storage_path =
        patch.audioStoragePath ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'errorCode',
      )
    ) {
      update.error_code =
        patch.errorCode ??
        null;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .update(update)
        .eq(
          'id',
          id,
        )
        .select('*')
        .single();

    if (error) {
      throw error;
    }

    return this.mapJob(
      data as DbGenerationJob,
    );
  }

  async getLatestJob(
    contactId: string,
  ): Promise<
    GenerationJob | undefined
  > {
    if (!this.supabase.isEnabled()) {
      const job = [
        ...this.jobs.values(),
      ]
        .filter(
          (item) =>
            item.contactId ===
            contactId,
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(
              a.createdAt,
            ),
        )[0];

      return job
        ? { ...job }
        : undefined;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .select('*')
        .eq(
          'contact_id',
          contactId,
        )
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(1)
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapJob(
          data as DbGenerationJob,
        )
      : undefined;
  }

  async getStaleProcessingJobs(
    updatedBefore: string,
  ): Promise<GenerationJob[]> {
    if (!this.supabase.isEnabled()) {
      return [
        ...this.jobs.values(),
      ]
        .filter(
          (job) =>
            job.status ===
              'processing' &&
            job.updatedAt <
              updatedBefore,
        )
        .map(
          (job) => ({
            ...job,
          }),
        );
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_jobs',
        )
        .select('*')
        .eq(
          'status',
          'processing',
        )
        .lt(
          'updated_at',
          updatedBefore,
        )
        .order(
          'updated_at',
          {
            ascending: true,
          },
        );

    if (error) {
      throw error;
    }

    return (
      (
        data ?? []
      ) as DbGenerationJob[]
    ).map(
      (row) =>
        this.mapJob(row),
    );
  }

  async createGenerationSegments(
    inputs:
      CreateGenerationSegmentInput[],
  ): Promise<
    GenerationSegment[]
  > {
    if (
      inputs.length === 0
    ) {
      return [];
    }

    if (!this.supabase.isEnabled()) {
      const now =
        new Date().toISOString();

      const created =
        inputs.map(
          (input) => {
            const segment:
              GenerationSegment = {
              id: randomUUID(),
              jobId:
                input.jobId,
              sceneIndex:
                input.sceneIndex,
              status:
                'queued',
              prompt:
                input.prompt,
              narrationText:
                input.narrationText,
              overlayText:
                input.overlayText,
              transition:
                input.transition,
              durationSeconds:
                input.durationSeconds,
              inputStoragePath:
                input.inputStoragePath,
              inputMimeType:
                input.inputMimeType,
              attempts: 0,
              createdAt: now,
              updatedAt: now,
            };

            this.segments.set(
              segment.id,
              segment,
            );

            return {
              ...segment,
            };
          },
        );

      return created;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_segments',
        )
        .insert(
          inputs.map(
            (input) => ({
              job_id:
                input.jobId,
              scene_index:
                input.sceneIndex,
              status:
                'queued',
              prompt:
                input.prompt,
              narration_text:
                input.narrationText ??
                null,
              overlay_text:
                input.overlayText ??
                null,
              transition:
                input.transition,
              duration_seconds:
                input.durationSeconds,
              input_storage_path:
                input.inputStoragePath,
              input_mime_type:
                input.inputMimeType,
              attempts: 0,
            }),
          ),
        )
        .select('*');

    if (error) {
      throw error;
    }

    return (
      (
        data ?? []
      ) as DbGenerationSegment[]
    ).map(
      (row) =>
        this.mapSegment(row),
    );
  }

  async getGenerationSegments(
    jobId: string,
  ): Promise<
    GenerationSegment[]
  > {
    if (!this.supabase.isEnabled()) {
      return [
        ...this.segments.values(),
      ]
        .filter(
          (segment) =>
            segment.jobId ===
            jobId,
        )
        .sort(
          (a, b) =>
            a.sceneIndex -
            b.sceneIndex,
        )
        .map(
          (segment) => ({
            ...segment,
          }),
        );
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_segments',
        )
        .select('*')
        .eq(
          'job_id',
          jobId,
        )
        .order(
          'scene_index',
          {
            ascending: true,
          },
        );

    if (error) {
      throw error;
    }

    return (
      (
        data ?? []
      ) as DbGenerationSegment[]
    ).map(
      (row) =>
        this.mapSegment(row),
    );
  }

  async claimNextGenerationSegment(
    jobId?: string,
  ): Promise<
    GenerationSegment | undefined
  > {
    if (!this.supabase.isEnabled()) {
      const next = [
        ...this.segments.values(),
      ]
        .filter(
          (segment) =>
            segment.status ===
              'queued' &&
            (
              !jobId ||
              segment.jobId ===
                jobId
            ),
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(
              b.createdAt,
            ),
        )[0];

      if (!next) {
        return undefined;
      }

      const claimed:
        GenerationSegment = {
        ...next,
        status:
          'processing',
        attempts:
          next.attempts + 1,
        updatedAt:
          new Date().toISOString(),
      };

      this.segments.set(
        claimed.id,
        claimed,
      );

      return {
        ...claimed,
      };
    }

    let query =
      this.supabase.client
        .from(
          'generation_segments',
        )
        .select('*')
        .eq(
          'status',
          'queued',
        );

    if (jobId) {
      query =
        query.eq(
          'job_id',
          jobId,
        );
    }

    const {
      data: candidate,
      error: selectError,
    } =
      await query
        .order(
          'created_at',
          {
            ascending: true,
          },
        )
        .limit(1)
        .maybeSingle();

    if (selectError) {
      throw selectError;
    }

    if (!candidate) {
      return undefined;
    }

    const row =
      candidate as DbGenerationSegment;

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_segments',
        )
        .update({
          status:
            'processing',
          attempts:
            row.attempts + 1,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          row.id,
        )
        .eq(
          'status',
          'queued',
        )
        .select('*')
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? this.mapSegment(
          data as DbGenerationSegment,
        )
      : undefined;
  }

  async updateGenerationSegment(
    id: string,
    patch:
      GenerationSegmentPatch,
  ): Promise<
    GenerationSegment
  > {
    if (!this.supabase.isEnabled()) {
      const current =
        this.segments.get(id);

      if (!current) {
        throw new Error(
          `Generation segment not found: ${id}`,
        );
      }

      const next:
        GenerationSegment = {
        ...current,
        ...patch,
        updatedAt:
          new Date().toISOString(),
      };

      this.segments.set(
        id,
        next,
      );

      return {
        ...next,
      };
    }

    const update: Record<
      string,
      unknown
    > = {
      updated_at:
        new Date().toISOString(),
    };

    if (
      this.hasOwn(
        patch,
        'status',
      )
    ) {
      update.status =
        patch.status;
    }

    if (
      this.hasOwn(
        patch,
        'outputStoragePath',
      )
    ) {
      update.output_storage_path =
        patch.outputStoragePath ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'providerJobId',
      )
    ) {
      update.provider_job_id =
        patch.providerJobId ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'attempts',
      )
    ) {
      update.attempts =
        patch.attempts;
    }

    if (
      this.hasOwn(
        patch,
        'errorCode',
      )
    ) {
      update.error_code =
        patch.errorCode ??
        null;
    }

    if (
      this.hasOwn(
        patch,
        'errorMessage',
      )
    ) {
      update.error_message =
        patch.errorMessage ??
        null;
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from(
          'generation_segments',
        )
        .update(update)
        .eq(
          'id',
          id,
        )
        .select('*')
        .single();

    if (error) {
      throw error;
    }

    return this.mapSegment(
      data as DbGenerationSegment,
    );
  }


  async recordAdminEvent(
    input: RecordAdminEventInput,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      const id = randomUUID();

      this.adminEvents.set(id, {
        id,
        contactId: input.contactId,
        waId: input.waId,
        profileName: input.profileName,
        eventType: input.eventType,
        prompt: input.prompt,
        reason: input.reason,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      });

      return;
    }

    const { error } =
      await this.supabase.client
        .from('admin_events')
        .insert({
          contact_id:
            input.contactId ?? null,

          wa_id:
            input.waId ?? null,

          profile_name:
            input.profileName ?? null,

          event_type:
            input.eventType,

          prompt:
            input.prompt ?? null,

          reason:
            input.reason ?? null,

          metadata:
            input.metadata ?? {},
        });

    if (error) {
      throw error;
    }
  }

  async getAdminTodayStats(): Promise<{
    users: number;
    inboundMessages: number;
    videos: number;
    activeVideos: number;
    blocked: number;
  }> {
    const startOfToday =
      new Date();

    startOfToday.setUTCHours(
      0,
      0,
      0,
      0,
    );

    const since =
      startOfToday.toISOString();

    if (!this.supabase.isEnabled()) {
      const users =
        [...this.contacts.values()]
          .filter(
            (contact) =>
              contact.createdAt >= since,
          ).length;

      const inboundMessages =
        [...this.messages.values()]
          .filter(
            (message) =>
              message.direction ===
                'inbound' &&
              message.createdAt >= since,
          ).length;

      const todayJobs =
        [...this.jobs.values()]
          .filter(
            (job) =>
              job.createdAt >= since,
          );

      const activeVideos =
        [...this.jobs.values()]
          .filter(
            (job) =>
              job.status === 'queued' ||
              job.status ===
                'processing',
          ).length;

      const blocked =
        [...this.adminEvents.values()]
          .filter(
            (event) =>
              event.createdAt >= since &&
              event.eventType.includes(
                'blocked',
              ),
          ).length;

      return {
        users,
        inboundMessages,
        videos: todayJobs.length,
        activeVideos,
        blocked,
      };
    }

    const [
      usersResult,
      messagesResult,
      videosResult,
      activeResult,
      blockedResult,
    ] = await Promise.all([
      this.supabase.client
        .from('wa_contacts')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .gte('created_at', since),

      this.supabase.client
        .from('wa_messages')
        .select('wa_message_id', {
          count: 'exact',
          head: true,
        })
        .eq(
          'direction',
          'inbound',
        )
        .gte('created_at', since),

      this.supabase.client
        .from('generation_jobs')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .gte('created_at', since),

      this.supabase.client
        .from('generation_jobs')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .in(
          'status',
          [
            'queued',
            'processing',
          ],
        ),

      this.supabase.client
        .from('admin_events')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .ilike(
          'event_type',
          '%blocked%',
        )
        .gte('created_at', since),
    ]);

    const error =
      usersResult.error ??
      messagesResult.error ??
      videosResult.error ??
      activeResult.error ??
      blockedResult.error;

    if (error) {
      throw error;
    }

    return {
      users:
        usersResult.count ?? 0,

      inboundMessages:
        messagesResult.count ?? 0,

      videos:
        videosResult.count ?? 0,

      activeVideos:
        activeResult.count ?? 0,

      blocked:
        blockedResult.count ?? 0,
    };
  }

  async getRecentAdminEvents(
    limit = 10,
    eventType?: string,
  ): Promise<AdminEventRecord[]> {
    if (!this.supabase.isEnabled()) {
      return [
        ...this.adminEvents.values(),
      ]
        .filter(
          (event) =>
            !eventType ||
            event.eventType ===
              eventType ||
            (
              eventType === 'blocked' &&
              event.eventType.includes(
                'blocked',
              )
            ),
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(
              a.createdAt,
            ),
        )
        .slice(0, limit)
        .map(
          (event) => ({
            ...event,
            metadata: {
              ...event.metadata,
            },
          }),
        );
    }

    let query =
      this.supabase.client
        .from('admin_events')
        .select('*')
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(limit);

    if (eventType === 'blocked') {
      query =
        query.ilike(
          'event_type',
          '%blocked%',
        );
    } else if (eventType) {
      query =
        query.eq(
          'event_type',
          eventType,
        );
    }

    const {
      data,
      error,
    } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []).map(
      (row) => ({
        id:
          row.id as string,

        contactId:
          row.contact_id ??
          undefined,

        waId:
          row.wa_id ??
          undefined,

        profileName:
          row.profile_name ??
          undefined,

        eventType:
          row.event_type as string,

        prompt:
          row.prompt ??
          undefined,

        reason:
          row.reason ??
          undefined,

        metadata:
          (
            row.metadata ?? {}
          ) as Record<
            string,
            unknown
          >,

        createdAt:
          row.created_at as string,
      }),
    );
  }

  async getActiveJobsForAdmin(
    limit = 20,
  ): Promise<
    Array<{
      job: GenerationJob;
      contact?: Contact;
    }>
  > {
    if (!this.supabase.isEnabled()) {
      const jobs =
        [...this.jobs.values()]
          .filter(
            (job) =>
              job.status ===
                'queued' ||
              job.status ===
                'processing',
          )
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(
                a.createdAt,
              ),
          )
          .slice(0, limit);

      return jobs.map(
        (job) => ({
          job: {
            ...job,
          },
          contact:
            this.contacts.get(
              job.contactId,
            )
              ? {
                  ...this.contacts.get(
                    job.contactId,
                  )!,
                }
              : undefined,
        }),
      );
    }

    const {
      data,
      error,
    } =
      await this.supabase.client
        .from('generation_jobs')
        .select('*')
        .in(
          'status',
          [
            'queued',
            'processing',
          ],
        )
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(limit);

    if (error) {
      throw error;
    }

    const result: Array<{
      job: GenerationJob;
      contact?: Contact;
    }> = [];

    for (const row of data ?? []) {
      const job =
        this.mapJob(
          row as DbGenerationJob,
        );

      const contact =
        await this.getContactById(
          job.contactId,
        );

      result.push({
        job,
        contact,
      });
    }

    return result;
  }

  async getUserAdminHistory(
    waId: string,
  ): Promise<{
    contact?: Contact;
    messages: ConversationMessage[];
    jobs: GenerationJob[];
    events: AdminEventRecord[];
  }> {
    const normalizedWaId =
      waId
        .trim()
        .replace(/^\+/, '');

    const contact =
      await this.getContactByWaId(
        normalizedWaId,
      );

    if (!contact) {
      return {
        contact: undefined,
        messages: [],
        jobs: [],
        events: [],
      };
    }

    const messages =
      await this.getRecentMessages(
        contact.id,
        20,
      );

    if (!this.supabase.isEnabled()) {
      const jobs =
        [...this.jobs.values()]
          .filter(
            (job) =>
              job.contactId ===
              contact.id,
          )
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(
                a.createdAt,
              ),
          )
          .slice(0, 20)
          .map(
            (job) => ({
              ...job,
            }),
          );

      const events =
        [...this.adminEvents.values()]
          .filter(
            (event) =>
              event.contactId ===
                contact.id ||
              event.waId ===
                normalizedWaId,
          )
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(
                a.createdAt,
              ),
          )
          .slice(0, 20)
          .map(
            (event) => ({
              ...event,
              metadata: {
                ...event.metadata,
              },
            }),
          );

      return {
        contact,
        messages,
        jobs,
        events,
      };
    }

    const [
      jobsResult,
      eventsResult,
    ] = await Promise.all([
      this.supabase.client
        .from('generation_jobs')
        .select('*')
        .eq(
          'contact_id',
          contact.id,
        )
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(20),

      this.supabase.client
        .from('admin_events')
        .select('*')
        .eq(
          'wa_id',
          normalizedWaId,
        )
        .order(
          'created_at',
          {
            ascending: false,
          },
        )
        .limit(20),
    ]);

    if (jobsResult.error) {
      throw jobsResult.error;
    }

    if (eventsResult.error) {
      throw eventsResult.error;
    }

    const jobs =
      (
        jobsResult.data ??
        []
      ).map(
        (row) =>
          this.mapJob(
            row as DbGenerationJob,
          ),
      );

    const events =
      (
        eventsResult.data ??
        []
      ).map(
        (row) => ({
          id:
            row.id as string,

          contactId:
            row.contact_id ??
            undefined,

          waId:
            row.wa_id ??
            undefined,

          profileName:
            row.profile_name ??
            undefined,

          eventType:
            row.event_type as string,

          prompt:
            row.prompt ??
            undefined,

          reason:
            row.reason ??
            undefined,

          metadata:
            (
              row.metadata ??
              {}
            ) as Record<
              string,
              unknown
            >,

          createdAt:
            row.created_at as string,
        }),
      );

    return {
      contact,
      messages,
      jobs,
      events,
    };
  }

  private async setWebhookState(
    id: string,
    status: EventStatus,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      const event =
        this.webhookEvents.get(id);

      if (!event) {
        return;
      }

      this.webhookEvents.set(
        id,
        {
          ...event,
          status,
          errorMessage:
            undefined,
          updatedAt:
            new Date().toISOString(),
        },
      );

      return;
    }

    const {
      error,
    } =
      await this.supabase.client
        .from('webhook_events')
        .update({
          status,
          error_message: null,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          id,
        );

    if (error) {
      throw error;
    }
  }

  private mapContact(
    row: DbContact,
  ): Contact {
    return {
      id: row.id,
      waId: row.wa_id,
      profileName:
        row.profile_name ??
        undefined,
      state: row.state,
      freeVideoUsed:
        row.free_video_used ??
        false,
      pendingImagePath:
        row.pending_image_path ??
        undefined,
      pendingImageMime:
        row.pending_image_mime ??
        undefined,
      selectedVideoDurationSeconds:
        row.selected_video_duration_seconds ??
        10,
      pendingImagePaths:
        this.stringArray(
          row.pending_image_paths,
        ),
      pendingImageMimes:
        this.stringArray(
          row.pending_image_mimes,
        ),
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at,
    };
  }

  private mapWebhookEvent(
    row: DbWebhookEvent,
  ): WebhookEvent {
    return {
      id: row.id,
      eventKey:
        row.event_key,
      payload:
        row.payload,
      status:
        row.status,
      attempts:
        row.attempts,
      errorMessage:
        row.error_message ??
        undefined,
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at,
    };
  }

  private mapJob(
    row: DbGenerationJob,
  ): GenerationJob {
    return {
      id: row.id,
      contactId:
        row.contact_id,
      status:
        row.status,
      provider:
        row.provider,
      prompt:
        row.prompt,
      inputStoragePath:
        row.input_storage_path,
      inputMimeType:
        row.input_mime_type,
      outputStoragePath:
        row.output_storage_path ??
        undefined,
      providerJobId:
        row.provider_job_id ??
        undefined,
      errorMessage:
        row.error_message ??
        undefined,
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at,
      videoMode:
        row.video_mode ??
        'single',
      targetDurationSeconds:
        row.target_duration_seconds ??
        10,
      sceneCount:
        row.scene_count ??
        1,
      stage:
        row.stage ??
        'queued',
      progressCompleted:
        row.progress_completed ??
        0,
      progressTotal:
        row.progress_total ??
        1,
      sourceImagePaths:
        this.stringArray(
          row.source_image_paths,
        ),
      sourceImageMimes:
        this.stringArray(
          row.source_image_mimes,
        ),
      scenePlan:
        this.scenePlan(
          row.scene_plan,
        ),
      narrationText:
        row.narration_text ??
        undefined,
      musicMood:
        row.music_mood ??
        undefined,
      audioStoragePath:
        row.audio_storage_path ??
        undefined,
      errorCode:
        row.error_code ??
        undefined,
    };
  }

  private mapSegment(
    row: DbGenerationSegment,
  ): GenerationSegment {
    return {
      id: row.id,
      jobId:
        row.job_id,
      sceneIndex:
        row.scene_index,
      status:
        row.status,
      prompt:
        row.prompt,
      narrationText:
        row.narration_text ??
        undefined,
      overlayText:
        row.overlay_text ??
        undefined,
      transition:
        row.transition,
      durationSeconds:
        row.duration_seconds,
      inputStoragePath:
        row.input_storage_path,
      inputMimeType:
        row.input_mime_type,
      outputStoragePath:
        row.output_storage_path ??
        undefined,
      providerJobId:
        row.provider_job_id ??
        undefined,
      attempts:
        row.attempts,
      errorCode:
        row.error_code ??
        undefined,
      errorMessage:
        row.error_message ??
        undefined,
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at,
    };
  }

  private mapMessage(
    row: DbMessage,
  ): ConversationMessage {
    return {
      waMessageId:
        row.wa_message_id,
      contactId:
        row.contact_id,
      direction:
        row.direction,
      type:
        row.type,
      content:
        row.content,
      status:
        row.status,
      createdAt:
        row.created_at,
    };
  }

  private stringArray(
    value: unknown,
  ): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (
        item,
      ): item is string =>
        typeof item ===
        'string',
    );
  }

  private scenePlan(
    value: unknown,
  ):
    | GenerationScenePlan[]
    | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value as GenerationScenePlan[];
  }

  private hasOwn<
    T extends object,
  >(
    object: T,
    key: PropertyKey,
  ): boolean {
    return Object.prototype.hasOwnProperty.call(
      object,
      key,
    );
  }
}
