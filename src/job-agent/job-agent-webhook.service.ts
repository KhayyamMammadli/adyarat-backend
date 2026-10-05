import { Injectable, Logger } from '@nestjs/common';
import { JobAgentService } from './job-agent.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import {
  WhatsAppInteractiveMessage,
  WhatsAppTextMessage,
  WhatsAppWebhookPayload,
} from '../whatsapp/whatsapp.types';
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
          const textMessage = message as WhatsAppTextMessage;
          await this.jobAgent.handleText(textMessage.from, textMessage.text.body, profileName);
          continue;
        }

        if (message.type === 'interactive' && 'interactive' in message) {
          const interactiveMessage = message as WhatsAppInteractiveMessage;
          const value =
            interactiveMessage.interactive.button_reply?.id ??
            interactiveMessage.interactive.list_reply?.id ??
            interactiveMessage.interactive.button_reply?.title ??
            interactiveMessage.interactive.list_reply?.title;

          if (value) {
            await this.jobAgent.handleInteractive(interactiveMessage.from, value, profileName);
            continue;
          }
        }

        await this.whatsapp.sendText(
          message.from,
          'Bu addımda mətnlə cavab verin və ya aşağıdakı menyudan seçim edin.',
        );
        await this.whatsapp.sendJobMainMenu(message.from, profileName);
      } catch (error) {
        this.logger.error(
          `Job Agent message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
  }
}
