import { Module } from '@nestjs/common';
import { JobAgentService } from './job-agent.service';
import { JobAgentWebhookService } from './job-agent-webhook.service';

@Module({
  providers: [JobAgentService, JobAgentWebhookService],
  exports: [JobAgentService, JobAgentWebhookService],
})
export class JobAgentModule {}
