import { Module } from '@nestjs/common';

import { AiOrchestratorService } from './ai-orchestrator.service';
import { AudioComposerService } from './audio-composer.service';
import { DocumentTranslationService } from './document-translation.service';
import { LongVideoPlannerService } from './long-video-planner.service';

@Module({
  providers: [
    AiOrchestratorService,
    AudioComposerService,
    DocumentTranslationService,
    LongVideoPlannerService,
  ],

  exports: [
    AiOrchestratorService,
    AudioComposerService,
    DocumentTranslationService,
    LongVideoPlannerService,
  ],
})
export class AiModule {}
