import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobAdminService } from '../job-agent/job-admin.service';
import { TelegramAdminService } from './telegram-admin.service';

type TelegramUpdate = { message?: { chat?: { id?: number }; text?: string } };

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: ConfigService,
    private readonly telegramAdmin: TelegramAdminService,
    private readonly jobAdmin: JobAdminService,
  ) {}

  @Post('webhook')
  async webhook(
    @Body() update: TelegramUpdate,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ): Promise<{ ok: true }> {
    const expectedSecret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim();
    if (expectedSecret && secretToken !== expectedSecret) return { ok: true };

    const chatId = update.message?.chat?.id;
    const text = update.message?.text?.trim();
    const adminChatId = this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')?.trim();
    if (!chatId || !text || String(chatId) !== adminChatId) return { ok: true };

    if (await this.handleJobCommand(text)) return { ok: true };
    await this.telegramAdmin.handleCommand(text);
    return { ok: true };
  }

  private async handleJobCommand(text: string): Promise<boolean> {
    const [rawCommand, idText, ...reasonParts] = text.split(/\s+/u);
    const command = rawCommand.toLocaleLowerCase('az-AZ').split('@')[0];

    if (command === '/pending' || command === '/vakansiyalar') {
      const jobs = await this.jobAdmin.pending(10);
      if (!jobs.length) {
        await this.telegramAdmin.sendMessage('✅ Gözləyən vakansiya yoxdur.');
        return true;
      }
      const lines = ['📋 GÖZLƏYƏN VAKANSİYALAR', ''];
      for (const job of jobs) {
        const salary = job.salary_min || job.salary_max
          ? `${job.salary_min ?? ''}${job.salary_min && job.salary_max ? '–' : ''}${job.salary_max ?? ''} ${job.salary_currency ?? 'AZN'}`
          : 'göstərilməyib';
        lines.push(
          `#${job.id} — ${job.title}`,
          `🏢 ${job.company_name ?? 'Şirkət göstərilməyib'}`,
          `📍 ${job.location_name ?? 'Lokasiya göstərilməyib'}`,
          `💼 ${job.work_mode ?? '-'}`,
          `💰 ${salary}`,
          job.description ? `📝 ${String(job.description).slice(0, 500)}` : '',
          `☎️ ${job.contact_phone ?? '-'}`,
          `✅ /approve ${job.id}`,
          `❌ /reject ${job.id} səbəb`,
          '',
        );
      }
      await this.telegramAdmin.sendMessage(lines.filter(Boolean).join('\n'));
      return true;
    }

    if (command === '/approve') {
      const id = Number(idText);
      if (!Number.isInteger(id) || id <= 0) {
        await this.telegramAdmin.sendMessage('⚠️ İstifadə: /approve 123');
        return true;
      }
      try {
        const job = await this.jobAdmin.approve(id);
        await this.telegramAdmin.sendMessage(`✅ #${id} təsdiqləndi və aktiv edildi.\n📢 ${job.title}`);
      } catch (error) {
        await this.telegramAdmin.sendMessage(`❌ #${id} təsdiqlənmədi: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }

    if (command === '/reject') {
      const id = Number(idText);
      if (!Number.isInteger(id) || id <= 0) {
        await this.telegramAdmin.sendMessage('⚠️ İstifadə: /reject 123 səbəb');
        return true;
      }
      const reason = reasonParts.join(' ').trim();
      try {
        const job = await this.jobAdmin.reject(id, reason || undefined);
        await this.telegramAdmin.sendMessage(`❌ #${id} rədd edildi.\n📢 ${job.title}${reason ? `\nSəbəb: ${reason}` : ''}`);
      } catch (error) {
        await this.telegramAdmin.sendMessage(`❌ #${id} rədd edilə bilmədi: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }

    return false;
  }
}
