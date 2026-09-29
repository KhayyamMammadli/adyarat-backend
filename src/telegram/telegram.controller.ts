import {
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { TelegramAdminService } from './telegram-admin.service';

type TelegramUpdate = {
  message?: {
    chat?: {
      id?: number;
    };
    text?: string;
  };
};

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: ConfigService,
    private readonly telegramAdmin: TelegramAdminService,
  ) {}

  @Post('webhook')
  async webhook(
    @Body() update: TelegramUpdate,
    @Headers('x-telegram-bot-api-secret-token')
    secretToken?: string,
  ): Promise<{ ok: true }> {
    const expectedSecret =
      this.config
        .get<string>('TELEGRAM_WEBHOOK_SECRET')
        ?.trim();

    if (
      expectedSecret &&
      secretToken !== expectedSecret
    ) {
      return { ok: true };
    }

    const chatId =
      update.message?.chat?.id;

    const text =
      update.message?.text?.trim();

    const adminChatId =
      this.config
        .get<string>('TELEGRAM_ADMIN_CHAT_ID')
        ?.trim();

    if (
      !chatId ||
      !text ||
      String(chatId) !== adminChatId
    ) {
      return { ok: true };
    }

    await this.telegramAdmin.handleCommand(
      text,
    );

    return { ok: true };
  }
}
