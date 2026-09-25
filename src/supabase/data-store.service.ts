import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Contact,
  ContactState,
  ConversationMessage,
  CreateJobInput,
  EventStatus,
  GenerationJob,
  JobStatus,
  MessageRecord,
  WebhookEvent,
} from '../common/domain';
import { SupabaseService } from './supabase.service';

type ContactPatch = Partial<
  Pick<
    Contact,
    'profileName' | 'state' | 'pendingImagePath' | 'pendingImageMime'
  >
>;

type JobPatch = Partial<
  Pick<
    GenerationJob,
    'status' | 'outputStoragePath' | 'providerJobId' | 'errorMessage'
  >
>;

interface DbContact {
  id: string;
  wa_id: string;
  profile_name: string | null;
  state: ContactState;
  pending_image_path: string | null;
  pending_image_mime: string | null;
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
}

interface DbMessage {
  wa_message_id: string;
  contact_id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  content: unknown;
  status: string;
  created_at: string;
}

@Injectable()
export class DataStoreService {
  private readonly contacts = new Map<string, Contact>();
  private readonly contactsByWaId = new Map<string, string>();
  private readonly webhookEvents = new Map<string, WebhookEvent>();
  private readonly eventIdsByKey = new Map<string, string>();
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly messageIds = new Set<string>();
  private readonly messageStatuses = new Map<string, string>();
  private readonly messages: ConversationMessage[] = [];

  constructor(private readonly supabase: SupabaseService) {}

  persistenceMode(): 'supabase' | 'memory' {
    return this.supabase.isEnabled() ? 'supabase' : 'memory';
  }

  async enqueueWebhook(
    eventKey: string,
    payload: unknown,
  ): Promise<boolean> {
    if (!this.supabase.isEnabled()) {
      if (this.eventIdsByKey.has(eventKey)) {
        return false;
      }

      const now = new Date().toISOString();

      const event: WebhookEvent = {
        id: randomUUID(),
        eventKey,
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };

      this.webhookEvents.set(event.id, event);
      this.eventIdsByKey.set(eventKey, event.id);

      return true;
    }

    const { error } = await this.supabase.client
      .from('webhook_events')
      .insert({
        event_key: eventKey,
        payload,
        status: 'pending',
      });

    if (!error) {
      return true;
    }

    if (error.code === '23505') {
      return false;
    }

    throw error;
  }

  async claimNextWebhook(): Promise<WebhookEvent | undefined> {
    if (!this.supabase.isEnabled()) {
      const event = [...this.webhookEvents.values()]
        .filter((item) => item.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!event) {
        return undefined;
      }

      event.status = 'processing';
      event.attempts += 1;
      event.updatedAt = new Date().toISOString();

      return { ...event };
    }

    const { data: candidate, error: readError } =
      await this.supabase.client
        .from('webhook_events')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle<DbWebhookEvent>();

    if (readError) {
      throw readError;
    }

    if (!candidate) {
      return undefined;
    }

    const { data, error } = await this.supabase.client
      .from('webhook_events')
      .update({
        status: 'processing',
        attempts: candidate.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle<DbWebhookEvent>();

    if (error) {
      throw error;
    }

    return data ? this.toWebhookEvent(data) : undefined;
  }

  async completeWebhook(id: string): Promise<void> {
    await this.updateWebhook(id, 'completed');
  }

  async failWebhook(
    id: string,
    errorMessage: string,
  ): Promise<void> {
    await this.updateWebhook(id, 'failed', errorMessage);
  }

  private async updateWebhook(
    id: string,
    status: EventStatus,
    errorMessage?: string,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      const event = this.webhookEvents.get(id);

      if (!event) {
        return;
      }

      event.status = status;
      event.errorMessage = errorMessage;
      event.updatedAt = new Date().toISOString();

      return;
    }

    const { error } = await this.supabase.client
      .from('webhook_events')
      .update({
        status,
        error_message: errorMessage ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw error;
    }
  }

  async getOrCreateContact(
    waId: string,
    profileName?: string,
  ): Promise<Contact> {
    if (!this.supabase.isEnabled()) {
      const existingId = this.contactsByWaId.get(waId);

      if (existingId) {
        const existing = this.contacts.get(existingId)!;

        if (
          profileName &&
          profileName !== existing.profileName
        ) {
          existing.profileName = profileName;
          existing.updatedAt = new Date().toISOString();
        }

        return { ...existing };
      }

      const now = new Date().toISOString();

      const contact: Contact = {
        id: randomUUID(),
        waId,
        profileName,
        state: 'new',
        createdAt: now,
        updatedAt: now,
      };

      this.contacts.set(contact.id, contact);
      this.contactsByWaId.set(waId, contact.id);

      return { ...contact };
    }

    const { data: existing, error: readError } =
      await this.supabase.client
        .from('wa_contacts')
        .select('*')
        .eq('wa_id', waId)
        .maybeSingle<DbContact>();

    if (readError) {
      throw readError;
    }

    if (existing) {
      if (
        profileName &&
        profileName !== existing.profile_name
      ) {
        return this.updateContact(existing.id, {
          profileName,
        });
      }

      return this.toContact(existing);
    }

    const { data, error } = await this.supabase.client
      .from('wa_contacts')
      .insert({
        wa_id: waId,
        profile_name: profileName ?? null,
        state: 'new',
      })
      .select('*')
      .single<DbContact>();

    if (error) {
      throw error;
    }

    return this.toContact(data);
  }

  async getContactById(
    id: string,
  ): Promise<Contact | undefined> {
    if (!this.supabase.isEnabled()) {
      const contact = this.contacts.get(id);
      return contact ? { ...contact } : undefined;
    }

    const { data, error } = await this.supabase.client
      .from('wa_contacts')
      .select('*')
      .eq('id', id)
      .maybeSingle<DbContact>();

    if (error) {
      throw error;
    }

    return data ? this.toContact(data) : undefined;
  }

  async updateContact(
    id: string,
    patch: ContactPatch,
  ): Promise<Contact> {
    if (!this.supabase.isEnabled()) {
      const contact = this.contacts.get(id);

      if (!contact) {
        throw new Error(`Contact ${id} not found`);
      }

      Object.assign(contact, patch, {
        updatedAt: new Date().toISOString(),
      });

      return { ...contact };
    }

    const dbPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if ('profileName' in patch) {
      dbPatch.profile_name = patch.profileName ?? null;
    }

    if ('state' in patch) {
      dbPatch.state = patch.state;
    }

    if ('pendingImagePath' in patch) {
      dbPatch.pending_image_path =
        patch.pendingImagePath ?? null;
    }

    if ('pendingImageMime' in patch) {
      dbPatch.pending_image_mime =
        patch.pendingImageMime ?? null;
    }

    const { data, error } = await this.supabase.client
      .from('wa_contacts')
      .update(dbPatch)
      .eq('id', id)
      .select('*')
      .single<DbContact>();

    if (error) {
      throw error;
    }

    return this.toContact(data);
  }

  async recordMessage(
    message: MessageRecord,
  ): Promise<boolean> {
    if (!this.supabase.isEnabled()) {
      if (this.messageIds.has(message.waMessageId)) {
        return false;
      }

      this.messageIds.add(message.waMessageId);
      this.messageStatuses.set(
        message.waMessageId,
        message.status,
      );

      this.messages.push({
        ...message,
        createdAt: new Date().toISOString(),
      });

      return true;
    }

    const { error } = await this.supabase.client
      .from('wa_messages')
      .insert({
        wa_message_id: message.waMessageId,
        contact_id: message.contactId,
        direction: message.direction,
        type: message.type,
        content: message.content,
        status: message.status,
      });

    if (!error) {
      return true;
    }

    if (error.code === '23505') {
      return false;
    }

    throw error;
  }

  async updateMessageStatus(
    waMessageId: string,
    status: string,
  ): Promise<void> {
    if (!this.supabase.isEnabled()) {
      this.messageStatuses.set(waMessageId, status);
      return;
    }

    const { error } = await this.supabase.client
      .from('wa_messages')
      .update({ status })
      .eq('wa_message_id', waMessageId);

    if (error) {
      throw error;
    }
  }

  async getRecentMessages(
    contactId: string,
    limit = 12,
  ): Promise<ConversationMessage[]> {
    if (!this.supabase.isEnabled()) {
      return this.messages
        .filter((item) => item.contactId === contactId)
        .slice(-limit);
    }

    const { data, error } = await this.supabase.client
      .from('wa_messages')
      .select(
        'wa_message_id,contact_id,direction,type,content,status,created_at',
      )
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<DbMessage[]>();

    if (error) {
      throw error;
    }

    return (data ?? [])
      .reverse()
      .map((row) => ({
        waMessageId: row.wa_message_id,
        contactId: row.contact_id,
        direction: row.direction,
        type: row.type,
        content: row.content,
        status: row.status,
        createdAt: row.created_at,
      }));
  }

  async createJob(
    input: CreateJobInput,
  ): Promise<GenerationJob> {
    if (!this.supabase.isEnabled()) {
      const now = new Date().toISOString();

      const job: GenerationJob = {
        id: randomUUID(),
        ...input,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };

      this.jobs.set(job.id, job);

      return { ...job };
    }

    const { data, error } = await this.supabase.client
      .from('generation_jobs')
      .insert({
        contact_id: input.contactId,
        status: 'queued',
        provider: input.provider,
        prompt: input.prompt,
        input_storage_path: input.inputStoragePath,
        input_mime_type: input.inputMimeType,
      })
      .select('*')
      .single<DbGenerationJob>();

    if (error) {
      throw error;
    }

    return this.toGenerationJob(data);
  }

  async hasActiveJob(contactId: string): Promise<boolean> {
    if (!this.supabase.isEnabled()) {
      return [...this.jobs.values()].some(
        (job) =>
          job.contactId === contactId &&
          ['queued', 'processing'].includes(job.status),
      );
    }

    const { count, error } = await this.supabase.client
      .from('generation_jobs')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('contact_id', contactId)
      .in('status', ['queued', 'processing']);

    if (error) {
      throw error;
    }

    return (count ?? 0) > 0;
  }

  async claimNextJob(): Promise<GenerationJob | undefined> {
    if (!this.supabase.isEnabled()) {
      const job = [...this.jobs.values()]
        .filter((item) => item.status === 'queued')
        .sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )[0];

      if (!job) {
        return undefined;
      }

      job.status = 'processing';
      job.updatedAt = new Date().toISOString();

      return { ...job };
    }

    const { data: candidate, error: readError } =
      await this.supabase.client
        .from('generation_jobs')
        .select('*')
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle<DbGenerationJob>();

    if (readError) {
      throw readError;
    }

    if (!candidate) {
      return undefined;
    }

    const { data, error } = await this.supabase.client
      .from('generation_jobs')
      .update({
        status: 'processing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle<DbGenerationJob>();

    if (error) {
      throw error;
    }

    return data
      ? this.toGenerationJob(data)
      : undefined;
  }

  async getStaleProcessingJobs(
    updatedBefore: string,
    limit = 10,
  ): Promise<GenerationJob[]> {
    if (!this.supabase.isEnabled()) {
      return [...this.jobs.values()]
        .filter(
          (job) =>
            job.status === 'processing' &&
            job.updatedAt < updatedBefore,
        )
        .sort((a, b) =>
          a.updatedAt.localeCompare(b.updatedAt),
        )
        .slice(0, limit)
        .map((job) => ({ ...job }));
    }

    const { data, error } = await this.supabase.client
      .from('generation_jobs')
      .select('*')
      .eq('status', 'processing')
      .lt('updated_at', updatedBefore)
      .order('updated_at', { ascending: true })
      .limit(limit)
      .returns<DbGenerationJob[]>();

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) =>
      this.toGenerationJob(row),
    );
  }

  async updateJob(
    id: string,
    patch: JobPatch,
  ): Promise<GenerationJob> {
    if (!this.supabase.isEnabled()) {
      const job = this.jobs.get(id);

      if (!job) {
        throw new Error(`Job ${id} not found`);
      }

      Object.assign(job, patch, {
        updatedAt: new Date().toISOString(),
      });

      return { ...job };
    }

    const dbPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if ('status' in patch) {
      dbPatch.status = patch.status;
    }

    if ('outputStoragePath' in patch) {
      dbPatch.output_storage_path =
        patch.outputStoragePath ?? null;
    }

    if ('providerJobId' in patch) {
      dbPatch.provider_job_id =
        patch.providerJobId ?? null;
    }

    if ('errorMessage' in patch) {
      dbPatch.error_message =
        patch.errorMessage ?? null;
    }

    const { data, error } = await this.supabase.client
      .from('generation_jobs')
      .update(dbPatch)
      .eq('id', id)
      .select('*')
      .single<DbGenerationJob>();

    if (error) {
      throw error;
    }

    return this.toGenerationJob(data);
  }

  async getLatestJob(
    contactId: string,
  ): Promise<GenerationJob | undefined> {
    if (!this.supabase.isEnabled()) {
      return [...this.jobs.values()]
        .filter(
          (job) => job.contactId === contactId,
        )
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        )[0];
    }

    const { data, error } = await this.supabase.client
      .from('generation_jobs')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<DbGenerationJob>();

    if (error) {
      throw error;
    }

    return data
      ? this.toGenerationJob(data)
      : undefined;
  }

  private toContact(row: DbContact): Contact {
    return {
      id: row.id,
      waId: row.wa_id,
      profileName: row.profile_name ?? undefined,
      state: row.state,
      pendingImagePath:
        row.pending_image_path ?? undefined,
      pendingImageMime:
        row.pending_image_mime ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toWebhookEvent(
    row: DbWebhookEvent,
  ): WebhookEvent {
    return {
      id: row.id,
      eventKey: row.event_key,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      errorMessage:
        row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toGenerationJob(
    row: DbGenerationJob,
  ): GenerationJob {
    return {
      id: row.id,
      contactId: row.contact_id,
      status: row.status,
      provider: row.provider,
      prompt: row.prompt,
      inputStoragePath: row.input_storage_path,
      inputMimeType: row.input_mime_type,
      outputStoragePath:
        row.output_storage_path ?? undefined,
      providerJobId:
        row.provider_job_id ?? undefined,
      errorMessage:
        row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
