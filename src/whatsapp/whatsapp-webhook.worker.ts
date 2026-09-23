import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/errors';
import { DataStoreService } from '../supabase/data-store.service';
import { WhatsAppProcessorService } from './whatsapp-processor.service';
import { WhatsAppWebhookPayload } from './whatsapp.types';

@Injectable()
export class WhatsAppWebhookWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WhatsAppWebhookWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dataStore: DataStoreService,
    private readonly processor: WhatsAppProcessorService,
  ) {}

  onModuleInit(): void {
    const interval = this.config.get<number>('WEBHOOK_POLL_MS') ?? 1000;
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
      const event = await this.dataStore.claimNextWebhook();
      if (!event) return;
      try {
        await this.processor.process(event.payload as WhatsAppWebhookPayload);
        await this.dataStore.completeWebhook(event.id);
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(`Webhook ${event.id} failed: ${message}`);
        await this.dataStore.failWebhook(event.id, message);
      }
    } finally {
      this.busy = false;
    }
  }
}
