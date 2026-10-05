import { Module } from '@nestjs/common';
import { JobAgentService } from './job-agent.service';

@Module({
  providers: [JobAgentService],
  exports: [JobAgentService],
})
export class JobAgentModule {}
