import { Module } from '@nestjs/common';
import { TelegramAdminService } from './telegram.service';

@Module({ providers: [TelegramAdminService], exports: [TelegramAdminService] })
export class TelegramTransportModule {}
