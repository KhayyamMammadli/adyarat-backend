import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ConversationMessage } from '../common/domain';
import { DataStoreService } from '../supabase/data-store.service';

@Injectable()
export class TelegramAdminService {
  private readonly logger =
    new Logger(
      TelegramAdminService.name,
    );

  constructor(
    private readonly config:
      ConfigService,
    private readonly dataStore:
      DataStoreService,
  ) {}

  private get botToken():
    | string
    | undefined {
    return this.config
      .get<string>(
        'TELEGRAM_BOT_TOKEN',
      )
      ?.trim();
  }

  private get adminChatId():
    | string
    | undefined {
    return this.config
      .get<string>(
        'TELEGRAM_ADMIN_CHAT_ID',
      )
      ?.trim();
  }

  isEnabled(): boolean {
    return Boolean(
      this.botToken &&
        this.adminChatId,
    );
  }

  async sendMessage(
    text: string,
  ): Promise<void> {
    const token =
      this.botToken;

    const chatId =
      this.adminChatId;

    if (!token || !chatId) {
      this.logger.warn(
        'Telegram admin notification skipped: configuration missing',
      );

      return;
    }

    for (
      const part of
      this.splitTelegramText(text)
    ) {
      try {
        const response =
          await fetch(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                chat_id: chatId,
                text: part,
                disable_web_page_preview:
                  true,
              }),
            },
          );

        if (!response.ok) {
          const errorText =
            await response.text();

          throw new Error(
            `Telegram API ${response.status}: ${errorText}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Telegram admin notification failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );

        return;
      }
    }
  }

  async handleCommand(
    rawText: string,
  ): Promise<void> {
    const text =
      rawText.trim();

    if (!text) {
      return;
    }

    const [
      rawCommand,
      ...args
    ] = text.split(/\s+/u);

    const command =
      rawCommand
        .toLocaleLowerCase('az-AZ')
        .split('@')[0];

    try {
      if (
        command === '/start' ||
        command === '/help' ||
        command === '/menu'
      ) {
        await this.sendHelp();
        return;
      }

      if (command === '/bugun') {
        await this.sendTodayStats();
        return;
      }

      if (command === '/son10') {
        await this.sendRecentEvents();
        return;
      }

      if (command === '/aktiv') {
        await this.sendActiveJobs();
        return;
      }

      if (command === '/bloklanan') {
        await this.sendBlockedEvents();
        return;
      }

      if (command === '/user') {
        const waId =
          args[0]?.trim();

        if (!waId) {
          await this.sendMessage(
            [
              '⚠️ İstifadəçi nömrəsini yazın.',
              '',
              'Məsələn:',
              '/user 994501234567',
            ].join('\n'),
          );

          return;
        }

        await this.sendUserHistory(
          waId,
        );

        return;
      }

      await this.sendMessage(
        [
          '❓ Naməlum komanda.',
          '',
          'Komandaları görmək üçün:',
          '/help',
        ].join('\n'),
      );
    } catch (error) {
      this.logger.warn(
        `Telegram admin command failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );

      await this.sendMessage(
        '❌ Admin komandası işlənərkən xəta baş verdi.',
      );
    }
  }

  private async sendHelp():
    Promise<void> {
    await this.sendMessage(
      [
        '🤖 AdYarat Admin',
        '',
        'Mövcud komandalar:',
        '',
        '/bugun — bu günün statistikası',
        '/son10 — son 10 admin hadisəsi',
        '/aktiv — aktiv videolar',
        '/bloklanan — son bloklanan sorğular',
        '/user 99450... — istifadəçi tarixçəsi',
        '/help — komandalar',
      ].join('\n'),
    );
  }

  private async sendTodayStats():
    Promise<void> {
    const stats =
      await this.dataStore
        .getAdminTodayStats();

    await this.sendMessage(
      [
        '📊 BUGÜNKÜ STATİSTİKA',
        '',
        `👥 Yeni istifadəçi: ${stats.users}`,
        `💬 Gələn mesaj: ${stats.inboundMessages}`,
        `🎬 Video sorğusu: ${stats.videos}`,
        `⏳ Aktiv video: ${stats.activeVideos}`,
        `🚫 Bloklanan: ${stats.blocked}`,
      ].join('\n'),
    );
  }

  private async sendRecentEvents():
    Promise<void> {
    const events =
      await this.dataStore
        .getRecentAdminEvents(
          10,
        );

    if (!events.length) {
      await this.sendMessage(
        '📭 Hələ admin hadisəsi yoxdur.',
      );

      return;
    }

    const lines: string[] = [
      '🕘 SON 10 HADİSƏ',
      '',
    ];

    events.forEach(
      (event, index) => {
        lines.push(
          `${index + 1}. ${this.eventLabel(event.eventType)}`,
          `👤 ${event.profileName ?? 'Adsız istifadəçi'}`,
          `📱 ${event.waId ?? '-'}`,
        );

        if (event.prompt) {
          lines.push(
            `📝 ${this.limitText(event.prompt, 300)}`,
          );
        }

        if (event.reason) {
          lines.push(
            `⚠️ ${this.limitText(event.reason, 250)}`,
          );
        }

        lines.push(
          `🕒 ${this.formatDate(event.createdAt)}`,
          '',
        );
      },
    );

    await this.sendMessage(
      lines.join('\n'),
    );
  }

  private async sendBlockedEvents():
    Promise<void> {
    const events =
      await this.dataStore
        .getRecentAdminEvents(
          10,
          'blocked',
        );

    if (!events.length) {
      await this.sendMessage(
        '✅ Bloklanan sorğu tapılmadı.',
      );

      return;
    }

    const lines: string[] = [
      '🚫 SON BLOKLANAN SORĞULAR',
      '',
    ];

    events.forEach(
      (event, index) => {
        lines.push(
          `${index + 1}. ${this.eventLabel(event.eventType)}`,
          `👤 ${event.profileName ?? 'Adsız istifadəçi'}`,
          `📱 ${event.waId ?? '-'}`,
        );

        if (event.prompt) {
          lines.push(
            `📝 Sorğu: ${this.limitText(event.prompt, 350)}`,
          );
        }

        if (event.reason) {
          lines.push(
            `⚠️ Səbəb: ${this.limitText(event.reason, 300)}`,
          );
        }

        lines.push(
          `🕒 ${this.formatDate(event.createdAt)}`,
          '',
        );
      },
    );

    await this.sendMessage(
      lines.join('\n'),
    );
  }

  private async sendActiveJobs():
    Promise<void> {
    const items =
      await this.dataStore
        .getActiveJobsForAdmin(
          20,
        );

    if (!items.length) {
      await this.sendMessage(
        '✅ Hazırda aktiv video yoxdur.',
      );

      return;
    }

    const lines: string[] = [
      '🎬 AKTİV VİDEOLAR',
      '',
    ];

    items.forEach(
      (
        {
          job,
          contact,
        },
        index,
      ) => {
        lines.push(
          `${index + 1}. ${job.status.toUpperCase()}`,
          `👤 ${contact?.profileName ?? 'Adsız istifadəçi'}`,
          `📱 ${contact?.waId ?? '-'}`,
          `⏱ ${job.targetDurationSeconds} saniyə`,
          `🎞 ${job.sceneCount} səhnə`,
          `📌 Stage: ${job.stage}`,
          `📈 ${job.progressCompleted}/${job.progressTotal}`,
          `📝 ${this.limitText(job.prompt, 350)}`,
          `🕒 ${this.formatDate(job.createdAt)}`,
          '',
        );
      },
    );

    await this.sendMessage(
      lines.join('\n'),
    );
  }

  private async sendUserHistory(
    waId: string,
  ): Promise<void> {
    const normalizedWaId =
      waId
        .trim()
        .replace(/^\+/, '');

    const history =
      await this.dataStore
        .getUserAdminHistory(
          normalizedWaId,
        );

    if (!history.contact) {
      await this.sendMessage(
        `❌ İstifadəçi tapılmadı: ${normalizedWaId}`,
      );

      return;
    }

    const {
      contact,
      messages,
      jobs,
      events,
    } = history;

    const lines: string[] = [
      '👤 İSTİFADƏÇİ TARİXÇƏSİ',
      '',
      `Ad: ${contact.profileName ?? 'Adsız istifadəçi'}`,
      `WhatsApp: ${contact.waId}`,
      `State: ${contact.state}`,
      `Pulsuz video istifadə olunub: ${contact.freeVideoUsed ? 'bəli' : 'xeyr'}`,
      '',
      `🎬 Son videolar: ${jobs.length}`,
    ];

    for (
      const job of
      jobs.slice(0, 5)
    ) {
      lines.push(
        '',
        `• ${job.status} — ${job.targetDurationSeconds}s`,
        `  ${this.limitText(job.prompt, 250)}`,
        `  ${this.formatDate(job.createdAt)}`,
      );
    }

    lines.push(
      '',
      `💬 Son mesajlar: ${messages.length}`,
    );

    for (
      const message of
      messages.slice(-8)
    ) {
      const messageText =
        this.extractMessageText(
          message,
        );

      if (!messageText) {
        continue;
      }

      lines.push(
        '',
        `${
          message.direction === 'inbound'
            ? '➡️ User'
            : '⬅️ Bot'
        }: ${this.limitText(messageText, 300)}`,
      );
    }

    lines.push(
      '',
      `🧾 Admin hadisələri: ${events.length}`,
    );

    for (
      const event of
      events.slice(0, 5)
    ) {
      lines.push(
        '',
        `• ${this.eventLabel(event.eventType)}`,
      );

      if (event.reason) {
        lines.push(
          `  Səbəb: ${this.limitText(event.reason, 200)}`,
        );
      }

      lines.push(
        `  ${this.formatDate(event.createdAt)}`,
      );
    }

    await this.sendMessage(
      lines.join('\n'),
    );
  }

  private extractMessageText(
    message: ConversationMessage,
  ): string | undefined {
    if (
      !message.content ||
      typeof message.content !==
        'object'
    ) {
      return undefined;
    }

    const content =
      message.content as {
        text?:
          | string
          | {
              body?: string;
            };
      };

    if (
      typeof content.text ===
      'string'
    ) {
      return content.text.trim();
    }

    if (
      typeof content.text?.body ===
      'string'
    ) {
      return content.text.body.trim();
    }

    return undefined;
  }

  private eventLabel(
    eventType: string,
  ): string {
    const labels:
      Record<string, string> = {
      video_created:
        '🎬 Video yaradıldı',
      video_blocked:
        '🚫 Video bloklandı',
      image_blocked:
        '🖼 Şəkil bloklandı',
      image_received:
        '🖼 Şəkil qəbul edildi',
      ai_blocked:
        '🤖 AI sorğusu bloklandı',
      ai_request:
        '🤖 AI sorğusu',
      ad_copy_created:
        '✍️ Reklam mətni yaradıldı',
      ad_copy_blocked:
        '🚫 Reklam mətni bloklandı',
      voice_ad_created:
        '🎙 Səsli reklam yaradıldı',
      voice_ad_blocked:
        '🚫 Səsli reklam bloklandı',
      support_request:
        '🆘 Dəstək müraciəti',
      daily_limit_blocked:
        '⏳ Gündəlik limit',
      cooldown_blocked:
        '⏱ Cooldown bloklandı',
      image_prompt_blocked:
        '🚫 Şəkil + prompt bloklandı',
    };

    return (
      labels[eventType] ??
      eventType
    );
  }

  private formatDate(
    iso: string,
  ): string {
    try {
      return new Intl.DateTimeFormat(
        'az-AZ',
        {
          timeZone: 'Asia/Baku',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        },
      ).format(
        new Date(iso),
      );
    } catch {
      return iso;
    }
  }

  private limitText(
    text: string,
    maxLength: number,
  ): string {
    const clean =
      text
        .replace(/\s+/gu, ' ')
        .trim();

    if (
      clean.length <=
      maxLength
    ) {
      return clean;
    }

    return (
      clean.slice(
        0,
        maxLength - 1,
      ) + '…'
    );
  }

  private splitTelegramText(
    text: string,
  ): string[] {
    const maxLength = 3900;

    if (
      text.length <=
      maxLength
    ) {
      return [text];
    }

    const parts: string[] = [];
    let remaining = text;

    while (
      remaining.length >
      maxLength
    ) {
      let splitAt =
        remaining.lastIndexOf(
          '\n',
          maxLength,
        );

      if (
        splitAt <
        maxLength * 0.5
      ) {
        splitAt = maxLength;
      }

      parts.push(
        remaining
          .slice(
            0,
            splitAt,
          )
          .trim(),
      );

      remaining =
        remaining
          .slice(splitAt)
          .trim();
    }

    if (remaining) {
      parts.push(remaining);
    }

    return parts;
  }
}
