import { Controller, Get } from '@nestjs/common';
import { DataStoreService } from './supabase/data-store.service';
import { MediaStoreService } from './media/media-store.service';

@Controller()
export class AppController {
  constructor(
    private readonly dataStore: DataStoreService,
    private readonly mediaStore: MediaStoreService,
  ) {}

  @Get()
  info(): Record<string, unknown> {
    return {
      name: 'AdYarat Backend',
      status: 'running',
      webhook: '/webhooks/whatsapp',
    };
  }

  @Get('health')
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      persistence: this.dataStore.persistenceMode(),
      mediaStorage: this.mediaStore.mode(),
      timestamp: new Date().toISOString(),
    };
  }
}
