import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/errors';
import { MediaStoreService } from '../media/media-store.service';
import { DataStoreService } from '../supabase/data-store.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { VideoProviderService } from './video-provider.service';

@Injectable()
export class GenerationWorkerService implements OnModuleInit, OnApplicationShutdown {
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
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = await this.dataStore.claimNextJob();
      if (!job) return;

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
        await this.mediaStore.put(outputPath, result.bytes, result.mimeType);

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
          content: { jobId: job.id, storagePath: outputPath },
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
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(`Generation job ${job.id} failed: ${message}`);
        await this.dataStore.updateJob(job.id, {
          status: 'failed',
          errorMessage: message.slice(0, 2000),
        });
        await this.dataStore.updateContact(contact.id, { state: 'awaiting_prompt' });
        await this.sendFailureMessage(contact.id, contact.waId);
      }
    } finally {
      this.busy = false;
    }
  }

  private async sendFailureMessage(contactId: string, waId: string): Promise<void> {
    const text =
      'Video hazırlanarkən texniki xəta baş verdi. Təsviri yenidən göndərərək təkrar yoxlaya bilərsiniz.';
    try {
      const messageId = await this.whatsapp.sendText(waId, text);
      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId,
        direction: 'outbound',
        type: 'text',
        content: { text },
        status: 'sent',
      });
    } catch (error) {
      this.logger.error(`Could not send failure message: ${errorMessage(error)}`);
    }
  }
}
