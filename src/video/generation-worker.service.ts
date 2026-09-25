import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contact, GenerationJob } from '../common/domain';
import { errorMessage, ExternalServiceError } from '../common/errors';
import { MediaStoreService } from '../media/media-store.service';
import { DataStoreService } from '../supabase/data-store.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { VideoProviderService } from './video-provider.service';

@Injectable()
export class GenerationWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(GenerationWorkerService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dataStore: DataStoreService,
    private readonly mediaStore: MediaStoreService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly provider: VideoProviderService,
  ) {}

  onModuleInit(): void {
    const interval = this.config.get<number>('GENERATION_POLL_MS') ?? 3000;

    void this.safeTick();

    this.timer = setInterval(() => void this.safeTick(), interval);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;

    try {
      await this.recoverStaleJobs();

      const job = await this.dataStore.claimNextJob();

      if (!job) {
        return;
      }

      const contact = await this.dataStore.getContactById(job.contactId);

      if (!contact) {
        await this.dataStore.updateJob(job.id, {
          status: 'failed',
          errorMessage: 'Contact not found',
        });

        return;
      }

      try {
        const image = await this.mediaStore.get(job.inputStoragePath);

        const result = await this.provider.generate({
          image,
          imageMimeType: job.inputMimeType,
          prompt: job.prompt,
        });

        const outputPath = `outputs/${contact.waId}/${job.id}.mp4`;

        await this.mediaStore.put(
          outputPath,
          result.bytes,
          result.mimeType,
        );

        const messageId = await this.whatsapp.sendVideo(
          contact.waId,
          result.bytes,
          'Videonuz hazırdır 🎬\nAdYarat ilə hazırlanıb.',
        );

        await this.dataStore.recordMessage({
          waMessageId: messageId,
          contactId: contact.id,
          direction: 'outbound',
          type: 'video',
          content: {
            jobId: job.id,
            storagePath: outputPath,
          },
          status: 'sent',
        });

        await this.dataStore.updateJob(job.id, {
          status: 'completed',
          outputStoragePath: outputPath,
          providerJobId: result.providerJobId,
          errorMessage: undefined,
        });

        await this.dataStore.updateContact(contact.id, {
          state: 'new',
          pendingImagePath: undefined,
          pendingImageMime: undefined,
        });

        await this.sendQuickActions(contact.id, contact.waId);
      } catch (error) {
        await this.handleGenerationFailure(job, contact, error);
      }
    } finally {
      this.busy = false;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(
        `Generation worker tick failed: ${errorMessage(error)}`,
      );
    }
  }

  private async handleGenerationFailure(
    job: GenerationJob,
    contact: Contact,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);

    this.logger.error(
      `Generation job ${job.id} failed: ${message}`,
    );

    try {
      await this.dataStore.updateJob(job.id, {
        status: 'failed',
        errorMessage: message.slice(0, 2000),
      });
    } catch (updateError) {
      this.logger.error(
        `Could not mark generation job ${job.id} as failed: ${errorMessage(
          updateError,
        )}`,
      );
    }

    try {
      await this.dataStore.updateContact(contact.id, {
        state: 'awaiting_prompt',
      });
    } catch (updateError) {
      this.logger.error(
        `Could not reset contact ${contact.id} after generation failure: ${errorMessage(
          updateError,
        )}`,
      );
    }

    await this.sendFailureMessage(
      contact.id,
      contact.waId,
      this.publicFailureMessage(error),
    );
  }

  private publicFailureMessage(error: unknown): string {
    if (error instanceof ExternalServiceError) {
      if (error.code === 'insufficient_credits') {
        return [
          'Video hazırlana bilmədi ❌',
          'Video xidməti hazırda müvəqqəti əlçatan deyil. Bir az sonra yenidən yoxlayın.',
          'Şəkliniz saxlanılıb; yenidən yalnız təsviri göndərə bilərsiniz.',
        ].join('\n');
      }

      if (error.code === 'invalid_request') {
        return [
          'Video hazırlana bilmədi ❌',
          'Şəkil və ya yazdığınız təsvir video xidməti tərəfindən qəbul edilmədi.',
          'Başqa şəkil və ya daha sadə təsvirlə yenidən yoxlayın.',
        ].join('\n');
      }

      if (error.code === 'rate_limited') {
        return [
          'Video hazırlana bilmədi ❌',
          'Video xidməti hazırda çox yüklənib. Bir neçə dəqiqə sonra yenidən yoxlayın.',
        ].join('\n');
      }
    }

    return [
      'Video hazırlanarkən texniki xəta baş verdi ❌',
      'Sorğu dayandırıldı. Şəkliniz saxlanılıb; bir az sonra təsviri yenidən göndərə bilərsiniz.',
    ].join('\n');
  }

  private async sendFailureMessage(
    contactId: string,
    waId: string,
    text: string,
  ): Promise<void> {
    try {
      const messageId = await this.whatsapp.sendText(waId, text);

      try {
        await this.dataStore.recordMessage({
          waMessageId: messageId,
          contactId,
          direction: 'outbound',
          type: 'text',
          content: {
            text,
            event: 'video-generation-failed',
          },
          status: 'sent',
        });
      } catch (error) {
        this.logger.error(
          `Failure message was sent but could not be recorded: ${errorMessage(
            error,
          )}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not send failure message: ${errorMessage(error)}`,
      );
    }

    await this.sendQuickActions(contactId, waId);
  }

  private async recoverStaleJobs(): Promise<void> {
    const staleMs =
      this.config.get<number>('GENERATION_STALE_MS') ??
      20 * 60 * 1000;

    const updatedBefore = new Date(
      Date.now() - staleMs,
    ).toISOString();

    const staleJobs =
      await this.dataStore.getStaleProcessingJobs(updatedBefore);

    for (const job of staleJobs) {
      const contact = await this.dataStore.getContactById(
        job.contactId,
      );

      await this.dataStore.updateJob(job.id, {
        status: 'failed',
        errorMessage: 'Generation timed out or worker restarted',
      });

      if (!contact) {
        continue;
      }

      await this.dataStore.updateContact(contact.id, {
        state: 'awaiting_prompt',
      });

      await this.sendFailureMessage(
        contact.id,
        contact.waId,
        [
          'Video sorğusunun emal müddəti bitdi ❌',
          'Sorğu dayandırıldı. Şəkliniz saxlanılıb; təsviri yenidən göndərə bilərsiniz.',
        ].join('\n'),
      );
    }
  }

  private async sendQuickActions(
    contactId: string,
    waId: string,
  ): Promise<void> {
    try {
      const messageId =
        await this.whatsapp.sendQuickActions(waId);

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId,
        direction: 'outbound',
        type: 'interactive',
        content: {
          menu: 'quick-actions',
        },
        status: 'sent',
      });
    } catch (error) {
      this.logger.warn(
        `Could not send quick actions: ${errorMessage(error)}`,
      );
    }
  }
}
