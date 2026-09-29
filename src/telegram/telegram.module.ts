import { Module } from '@nestjs/common';

import { TelegramAdminService } from './telegram-admin.service';
import { TelegramController } from './telegram.controller';

@Module({
  controllers: [
    TelegramController,
  ],

  providers: [
    TelegramAdminService,
  ],

  exports: [
    TelegramAdminService,
  ],
})
export class TelegramModule {}
