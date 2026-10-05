import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { validateEnvironment } from './common/environment';
import { JobAgentModule } from './job-agent/job-agent.module';
import { MediaModule } from './media/media.module';
import { SupabaseModule } from './supabase/supabase.module';
import { TelegramModule } from './telegram/telegram.module';
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
    JobAgentModule,
    VideoModule,
    TelegramModule,
  ],

  controllers: [
    AppController,
  ],
})
export class AppModule {}
