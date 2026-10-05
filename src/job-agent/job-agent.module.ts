import { BusinessRegistrationService } from './business-registration.service';
import { TaxpayerRegistryService } from './taxpayer-registry.service';
import { TelegramTransportModule } from '../telegram/telegram-transport.module';
import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppWebhookWorker } from '../whatsapp/whatsapp-webhook.worker';
import { JobAdminService } from './job-admin.service';
import { JobAgentService } from './job-agent.service';
import { JobAgentWebhookService } from './job-agent-webhook.service';

@Module({
  imports: [WhatsAppModule, TelegramTransportModule],
  providers: [
    BusinessRegistrationService,
    TaxpayerRegistryService,
    JobAdminService,
    JobAgentService,
    JobAgentWebhookService,
    WhatsAppWebhookWorker,
  ],
  exports: [BusinessRegistrationService, JobAdminService, JobAgentService, JobAgentWebhookService],
})
export class JobAgentModule {}
