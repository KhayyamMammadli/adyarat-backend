import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppProcessorService } from './whatsapp-processor.service';
import { WhatsAppWebhookWorker } from './whatsapp-webhook.worker';
import { WebhookSecurityService } from './webhook-security.service';

@Module({
  imports: [AiModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppClientService,
    WhatsAppProcessorService,
    WhatsAppWebhookWorker,
    WebhookSecurityService,
  ],
  exports: [WhatsAppClientService, WebhookSecurityService],
})
export class WhatsAppModule {}
