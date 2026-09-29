import { Module } from '@nestjs/common';
import { TelegramModule } from './telegram/telegram.module';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { validateEnvironment } from './common/environment';
import { MediaModule } from './media/media.module';
import { SupabaseModule } from './supabase/supabase.module';
import { VideoModule } from './video/video.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
  ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    validate: validateEnvironment,
  }),
  AiModule,
  SupabaseModule,
  MediaModule,
  WhatsAppModule,
  VideoModule,
  TelegramModule,
],,
  controllers: [AppController],
})
export class AppModule {}
