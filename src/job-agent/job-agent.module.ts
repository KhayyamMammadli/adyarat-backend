import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppWebhookWorker } from '../whatsapp/whatsapp-webhook.worker';
import { JobAgentService } from './job-agent.service';
import { JobAgentWebhookService } from './job-agent-webhook.service';

@Module({
  imports: [WhatsAppModule],
  providers: [
    JobAgentService,
    JobAgentWebhookService,
    WhatsAppWebhookWorker,
  ],
  exports: [JobAgentService, JobAgentWebhookService],
})
export class JobAgentModule {}
