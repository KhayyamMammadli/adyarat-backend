import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InlineKeyboard, ReplyMarkup } from './telegram.types';

@Injectable()
export class TelegramAdminService {
  private readonly logger = new Logger(TelegramAdminService.name);
  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() &&
      this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')?.trim(),
    );
  }

  // Submission notifications remain best effort, as before. /pending can recover them.
  async sendMessage(text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn('Telegram admin notification skipped: configuration missing');
      return;
    }
    try {
      await this.sendTo(
        this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')!.trim(),
        text,
        replyMarkup,
      );
    } catch {
      this.logger.warn('Telegram admin notification failed');
    }
  }

  async sendTo(
    chatId: number | string,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<{ message_id: number }> {
    if (!text.length || text.length > 4096)
      throw new Error('Telegram text must contain 1–4096 characters');
    if (replyMarkup && 'inline_keyboard' in replyMarkup) {
      for (const button of replyMarkup.inline_keyboard.flat()) {
        if (!button.callback_data || Buffer.byteLength(button.callback_data, 'utf8') > 64)
          throw new Error('Telegram callback data must contain 1–64 bytes');
      }
    }
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendPhoto(
    photo: string,
    caption: string,
    replyMarkup: InlineKeyboard,
    chatId?: number,
  ): Promise<void> {
    const target = chatId ?? this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')?.trim();
    if (!target || !this.isEnabled()) throw new Error('Telegram admin is not configured');
    if (caption.length > 1024) throw new Error('Telegram photo caption exceeds limit');
    for (const b of replyMarkup.inline_keyboard.flat())
      if (!b.callback_data || Buffer.byteLength(b.callback_data) > 64)
        throw new Error('Invalid callback');
    await this.request('sendPhoto', { chat_id: target, photo, caption, reply_markup: replyMarkup });
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.request('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text: text.slice(0, 200) } : {}),
    });
  }

  async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.request('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  private async request<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    if (!token) throw new Error('Telegram bot is not configured');
    // Never include the token-containing URL or raw API error in logs.
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Telegram API request failed');
    }
    const body = (await response.json()) as { ok?: boolean; result?: T };
    if (!response.ok || !body.ok || body.result === undefined)
      throw new Error(`Telegram API ${method} failed (${response.status})`);
    return body.result;
  }
}
