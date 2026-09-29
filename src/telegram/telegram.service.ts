import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramAdminService {
  private readonly logger =
    new Logger(
      TelegramAdminService.name,
    );

  constructor(
    private readonly config:
      ConfigService,
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
              text,
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
    }
  }
}
