import { Global, Module } from '@nestjs/common';
import { MediaStoreService } from './media-store.service';

@Global()
@Module({
  providers: [MediaStoreService],
  exports: [MediaStoreService],
})
export class MediaModule {}
