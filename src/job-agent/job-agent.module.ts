import { TelegramAdminService as TelegramNotifications } from '../telegram/telegram.service';
import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppWebhookWorker } from '../whatsapp/whatsapp-webhook.worker';
import { JobAdminService } from './job-admin.service';
import { JobAgentService } from './job-agent.service';
import { JobAgentWebhookService } from './job-agent-webhook.service';

@Module({
  imports: [WhatsAppModule],
  providers: [
    TelegramNotifications,
    JobAdminService,
    JobAgentService,
    JobAgentWebhookService,
    WhatsAppWebhookWorker,
  ],
  exports: [JobAdminService, JobAgentService, JobAgentWebhookService],
})
export class JobAgentModule {}
