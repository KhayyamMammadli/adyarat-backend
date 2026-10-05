import { Module } from '@nestjs/common';

import { JobAgentModule } from '../job-agent/job-agent.module';

import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppWebhookWorker } from './whatsapp-webhook.worker';
import { WebhookSecurityService } from './webhook-security.service';

@Module({
  imports: [JobAgentModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppClientService,
    WhatsAppWebhookWorker,
    WebhookSecurityService,
  ],
  exports: [
    WhatsAppClientService,
    WebhookSecurityService,
  ],
})
export class WhatsAppModule {}
