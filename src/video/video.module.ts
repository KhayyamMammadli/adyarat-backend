import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { GenerationWorkerService } from './generation-worker.service';
import { VideoProviderService } from './video-provider.service';

@Module({
  imports: [WhatsAppModule],
  providers: [VideoProviderService, GenerationWorkerService],
  exports: [VideoProviderService, GenerationWorkerService],
})
export class VideoModule {}
