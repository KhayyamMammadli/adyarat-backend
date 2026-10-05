import { Injectable, Logger } from '@nestjs/common';
import { JobAgentService } from './job-agent.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { WhatsAppWebhookPayload } from '../whatsapp/whatsapp.types';
import { extractMessages } from '../whatsapp/webhook.utils';

@Injectable()
export class JobAgentWebhookService {
  private readonly logger = new Logger(JobAgentWebhookService.name);

  constructor(
    private readonly jobAgent: JobAgentService,
    private readonly whatsapp: WhatsAppClientService,
  ) {}

  async process(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const { message, profileName } of extractMessages(payload)) {
      try {
        await this.whatsapp.markAsRead(message.id);

        if (message.type === 'text' && 'text' in message) {
          await this.jobAgent.handleText(
            message.from,
            message.text.body,
            profileName,
          );
          continue;
        }

        if (message.type === 'interactive' && 'interactive' in message) {
          const value =
            message.interactive.button_reply?.id ??
            message.interactive.list_reply?.id ??
            message.interactive.button_reply?.title ??
            message.interactive.list_reply?.title;

          if (value) {
            await this.jobAgent.handleText(message.from, value, profileName);
            continue;
          }
        }

        await this.whatsapp.sendText(
          message.from,
          'Hazırda mətn mesajları ilə davam edirik. “Menyu” yazaraq başlaya bilərsiniz.',
        );
      } catch (error) {
        this.logger.error(
          `Job Agent message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
  }
}
