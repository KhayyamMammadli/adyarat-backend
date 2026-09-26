import { Module } from '@nestjs/common';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { DocumentTranslationService } from './document-translation.service';
import { LongVideoPlannerService } from './long-video-planner.service';

@Module({
  providers: [
    AiOrchestratorService,
    DocumentTranslationService,
    LongVideoPlannerService,
  ],

  exports: [
    AiOrchestratorService,
    DocumentTranslationService,
    LongVideoPlannerService,
  ],
})
export class AiModule {}
