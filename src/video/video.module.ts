import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { GenerationWorkerService } from './generation-worker.service';
import { VideoComposerService } from './video-composer.service';
import { VideoProviderService } from './video-provider.service';

@Module({
  imports: [
    WhatsAppModule,
  ],

  providers: [
    VideoProviderService,
    VideoComposerService,
    GenerationWorkerService,
  ],

  exports: [
    VideoProviderService,
    VideoComposerService,
    GenerationWorkerService,
  ],
})
export class VideoModule {}
