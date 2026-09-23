import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    SupabaseModule,
    MediaModule,
    WhatsAppModule,
    VideoModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
