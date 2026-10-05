import { Module } from '@nestjs/common';

import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppController } from './whatsapp.controller';
import { WebhookSecurityService } from './webhook-security.service';

@Module({
  controllers: [WhatsAppController],
  providers: [
    WhatsAppClientService,
    WebhookSecurityService,
  ],
  exports: [
    WhatsAppClientService,
    WebhookSecurityService,
  ],
})
export class WhatsAppModule {}
