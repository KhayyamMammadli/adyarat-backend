
import { Module } from '@nestjs/common';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { DocumentTranslationService } from './document-translation.service';

@Module({
  providers: [
    AiOrchestratorService,
    DocumentTranslationService,
  ],
  exports: [
    AiOrchestratorService,
    DocumentTranslationService,
  ],
})
export class AiModule {}