import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramAdminService } from './telegram-admin.service';
import { TelegramAdminService as TelegramTransport } from './telegram.service';
import { TelegramJobAdminService } from './telegram-job-admin.service';
import { AdminActor, TelegramUpdate } from './telegram.types';

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: ConfigService,
    private readonly legacyAdmin: TelegramAdminService,
    private readonly jobs: TelegramJobAdminService,
    private readonly telegram: TelegramTransport,
  ) {}

  @Post('webhook')
  async webhook(
    @Body() update: TelegramUpdate,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ): Promise<{ ok: true }> {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim();
    if (expected ? secretToken !== expected : this.config.get<string>('NODE_ENV') === 'production')
      return { ok: true };
    const actor = this.authorize(update);
    if (!actor) {
      if (update.callback_query?.id) {
        try {
          await this.telegram.answerCallback(
            update.callback_query.id,
            'Bu əməliyyata icazəniz yoxdur.',
          );
        } catch {}
      }
      return { ok: true };
    }
    if (update.callback_query?.id) {
      try {
        await this.telegram.answerCallback(update.callback_query.id);
      } catch {}
    }
    if (await this.jobs.handle(actor, update)) return { ok: true };
    if (update.message?.text) await this.legacyAdmin.handleCommand(update.message.text);
    return { ok: true };
  }

  private authorize(update: TelegramUpdate): AdminActor | undefined {
    const message = update.callback_query?.message ?? update.message;
    const user = update.callback_query?.from ?? update.message?.from;
    const chatId = message?.chat?.id;
    const userId = user?.id;
    const configuredChat = this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')?.trim();
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId) || !userId || user?.is_bot)
      return undefined;
    const allowlist = this.config
      .get<string>('TELEGRAM_ADMIN_USER_IDS')
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    // A private chat ID is the admin's user ID. Groups must explicitly allow user IDs.
    const privateChat = chatId! > 0 && (!message?.chat?.type || message.chat.type === 'private');
    const listed = allowlist?.includes(String(userId)) ?? false;
    const allowed = privateChat
      ? userId === chatId && (listed || String(chatId) === configuredChat)
      : String(chatId) === configuredChat && listed;
    return allowed ? { chatId: chatId!, userId, group: !privateChat } : undefined;
  }
}
