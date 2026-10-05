import { BusinessRegistrationService } from '../job-agent/business-registration.service';
import { validCoordinates, validEmail } from '../job-agent/vacancy-validation';
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { JobAdminService } from '../job-agent/job-admin.service';
import { TelegramAdminService as TelegramTransport } from './telegram.service';
import {
  TelegramAdminStateService,
  AdminState,
  AdminSession,
} from './telegram-admin-state.service';
import { AdminActor, InlineKeyboard, TelegramUpdate } from './telegram.types';
import { formatTelegramJob, moderationButtons } from './job-message';

const PANEL: InlineKeyboard = {
  inline_keyboard: [
    [{ text: '➕ Vakansiya əlavə et', callback_data: 'tg:new' }],
    [{ text: '🏢 Biznes profilləri', callback_data: 'tg:businesses' }],
    [{ text: '📋 Gözləyən vakansiyalar', callback_data: 'tg:pending' }],
  ],
};
const STEPS = [
  'company_name',
  'title',
  'description',
  'location_name',
  'work_mode',
  'location_pin',
  'salary',
  'contact',
  'confirm',
];
const QUESTIONS: Record<string, string> = {
  company_name: '🏢 Şirkətin adını yazın.',
  title: '📢 Vəzifənin adını yazın.',
  description: '📝 Vakansiyanın açıqlamasını və tələblərini yazın.',
  location_name: '📍 Şəhəri və ünvanı yazın. Remote iş üçün şirkətin şəhərini yaza bilərsiniz.',
  location_pin:
    '📍 Telegram-da 📎 → Location ilə iş yerinin dəqiq məkanını göndərin. Qrupda cari suala Reply edin.',
  salary:
    '💰 AZN ilə maaşı və ya aralığı yazın. Məsələn: 1500 və ya 1000–2000. Maaş açıqlanmayacaqsa aşağıdakı düymədən istifadə edin.',
  contact:
    '☎️ Telefon və ya e-poçt yazın. Hər ikisini də yaza bilərsiniz: +994501234567 hr@example.com',
};

@Injectable()
export class TelegramJobAdminService {
  private readonly logger = new Logger(TelegramJobAdminService.name);
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly jobs: JobAdminService,
    private readonly states: TelegramAdminStateService,
    private readonly telegram: TelegramTransport,
    private readonly businesses: BusinessRegistrationService,
  ) {}

  async handle(actor: AdminActor, update: TelegramUpdate): Promise<boolean> {
    const key = `${actor.chatId}:${actor.userId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.process(actor, update));
    this.queues.set(key, task);
    try {
      return await task;
    } finally {
      if (this.queues.get(key) === task) this.queues.delete(key);
    }
  }

  private async process(actor: AdminActor, update: TelegramUpdate): Promise<boolean> {
    const action = update.callback_query?.data;
    const text = update.message?.text?.trim();
    const command = text?.split(/\s+/)[0].toLocaleLowerCase('az').split('@')[0];
    // Legacy diagnostics are delegated without intercepting them as draft/reject text.
    if (
      !action &&
      command?.startsWith('/') &&
      ![
        '/admin',
        '/start',
        '/menu',
        '/pending',
        '/vakansiyalar',
        '/approve',
        '/reject',
        '/cancel',
      ].includes(command)
    )
      return false;
    const state = await this.states.load(actor);
    const updateId = update.update_id;
    if (!Number.isSafeInteger(updateId)) return true;
    if (updateId! <= state.session.lastUpdateId) return true;
    const nextId = updateId!;
    const nonce = () => randomBytes(6).toString('hex');
    const idle = (): AdminSession => ({ kind: 'idle', lastUpdateId: nextId });
    const expired = state.session.expiresAt && state.session.expiresAt <= new Date().toISOString();

    if (action === 'tg:admin' || ['/admin', '/start', '/menu', '/cancel'].includes(command ?? '')) {
      await this.states.save(state, idle());
      await this.telegram.sendTo(actor.chatId, '👤 Vakansiya admin paneli', PANEL);
      return true;
    }
    if (action === 'tg:businesses') {
      await this.businesses.pending(actor.chatId);
      await this.states.save(state, { ...state.session, lastUpdateId: nextId });
      return true;
    }
    const business = /^biz:([ar]):([0-9a-f-]{36}):([0-9a-f]{12})$/.exec(action ?? '');
    if (business) {
      try {
        const changed = await this.businesses.moderate(
          business[2],
          business[3],
          business[1] === 'a',
          actor.userId,
        );
        if (changed)
          await this.removeModerationButtons(
            actor.chatId,
            update.callback_query?.message?.message_id,
          );
        await this.telegram.sendTo(
          actor.chatId,
          changed
            ? business[1] === 'a'
              ? '✅ Biznes profili təsdiqləndi.'
              : '❌ Biznes profili rədd edildi.'
            : 'Bu profil artıq yoxlanılıb və ya düymə köhnədir.',
          PANEL,
        );
      } catch {
        await this.telegram.sendTo(
          actor.chatId,
          'Profil əməliyyatı alınmadı. Yenidən cəhd edin.',
          PANEL,
        );
      }
      await this.states.save(state, { ...state.session, lastUpdateId: nextId });
      return true;
    }
    if (action === 'tg:pending' || command === '/pending' || command === '/vakansiyalar') {
      await this.sendPending(actor.chatId);
      await this.states.save(state, { ...state.session, lastUpdateId: nextId });
      return true;
    }
    if (action === 'tg:new') {
      const session: AdminSession = {
        kind: 'create',
        nonce: nonce(),
        step: STEPS[0],
        draft: {},
        lastUpdateId: nextId,
        expiresAt: this.expiry(),
      };
      await this.promptAndSave(actor, state, session);
      return true;
    }
    const approve =
      /^tg:approve:(\d+)$/.exec(action ?? '') ??
      (command === '/approve' ? /^\/approve(?:@\w+)?\s+(\d+)\s*$/.exec(text ?? '') : null);
    const reject =
      /^tg:reject:(\d+)$/.exec(action ?? '') ??
      (command === '/reject'
        ? /^\/reject(?:@\w+)?\s+(\d+)(?:\s+([\s\S]+))?$/.exec(text ?? '')
        : null);
    if (approve) {
      const jobId = this.jobId(approve[1]);
      if (!jobId) {
        await this.telegram.sendTo(actor.chatId, 'Vakansiya nömrəsi düzgün deyil.');
        return true;
      }
      try {
        await this.jobs.approve(jobId);
        await this.removeModerationButtons(
          actor.chatId,
          update.callback_query?.message?.message_id,
        );
        await this.telegram.sendTo(
          actor.chatId,
          `✅ #${jobId} təsdiqləndi və aktiv edildi.`,
          PANEL,
        );
      } catch (error) {
        await this.moderationError(actor.chatId, error);
      }
      await this.states.save(state, { ...state.session, lastUpdateId: nextId });
      return true;
    }
    if (reject) {
      const jobId = this.jobId(reject[1]);
      if (!jobId) {
        await this.telegram.sendTo(actor.chatId, 'Vakansiya nömrəsi düzgün deyil.');
        return true;
      }
      try {
        await this.jobs.getPending(jobId);
      } catch (error) {
        await this.moderationError(actor.chatId, error);
        return true;
      }
      if (reject[2]) {
        await this.jobs.reject(jobId, reject[2]);
        await this.states.save(state, idle());
        await this.telegram.sendTo(actor.chatId, `❌ #${jobId} rədd edildi.`, PANEL);
        return true;
      }
      await this.promptAndSave(actor, state, {
        kind: 'reject',
        nonce: nonce(),
        jobId,
        moderationMessageId: update.callback_query?.message?.message_id,
        lastUpdateId: nextId,
        expiresAt: this.expiry(),
      });
      return true;
    }
    if (action?.startsWith('tg:cancel:') && action === `tg:cancel:${state.session.nonce}`) {
      await this.states.save(state, idle());
      await this.telegram.sendTo(actor.chatId, 'Əməliyyat ləğv edildi.', PANEL);
      return true;
    }
    if (expired) {
      await this.states.save(state, idle());
      await this.telegram.sendTo(actor.chatId, 'Əməliyyatın vaxtı bitib. Yenidən başlayın.', PANEL);
      return true;
    }

    if (state.session.kind === 'create') {
      const prefix = `tg:create:${state.session.nonce}:`;
      if (action === `${prefix}publish` && state.session.step === 'confirm') {
        if (
          ['office', 'hybrid'].includes(state.session.draft?.work_mode) &&
          !validCoordinates(state.session.draft)
        ) {
          await this.promptAndSave(actor, state, {
            ...state.session,
            step: 'location_pin',
            lastUpdateId: nextId,
          });
          return true;
        }
        // Unique (source, source_id) makes publication idempotent even after a restart/retry.
        const job = await this.jobs.createActive(
          state.session.draft!,
          `${actor.chatId}:${actor.userId}:${state.session.nonce}`,
          actor.userId,
        );
        await this.states.save(state, idle());
        await this.removeModerationButtons(
          actor.chatId,
          update.callback_query?.message?.message_id,
        );
        await this.telegram.sendTo(
          actor.chatId,
          `✅ #${job.id} yaradıldı və aktiv edildi. WhatsApp vakansiya siyahısında görünür.`,
          PANEL,
        );
        return true;
      }
      const location = update.message?.venue?.location ?? update.message?.location;
      if (!action && location && state.session.step === 'location_pin') {
        if (!this.matchesReply(actor, state.session, update) || !validCoordinates(location)) {
          await this.telegram.sendTo(
            actor.chatId,
            'Cari suala Reply ilə düzgün lokasiya göndərin.',
          );
          return true;
        }
        await this.advance(
          actor,
          state,
          {
            latitude: location.latitude,
            longitude: location.longitude,
            ...(update.message?.venue?.address
              ? { location_name: update.message.venue.address.slice(0, 250) }
              : {}),
          },
          nextId,
        );
        return true;
      }
      if (state.session.step === 'work_mode' && action?.startsWith(`${prefix}mode:`)) {
        const mode = action.slice(`${prefix}mode:`.length);
        if (['office', 'remote', 'hybrid'].includes(mode)) {
          await this.advance(actor, state, { work_mode: mode }, nextId);
          return true;
        }
      }
      if (state.session.step === 'salary' && action === `${prefix}salary:negotiable`) {
        await this.advance(
          actor,
          state,
          { salary_min: null, salary_max: null, salary_currency: 'AZN' },
          nextId,
        );
        return true;
      }
      if (
        !action &&
        text &&
        !command?.startsWith('/') &&
        !['work_mode', 'location_pin', 'confirm'].includes(state.session.step!)
      ) {
        if (!this.matchesReply(actor, state.session, update)) {
          await this.telegram.sendTo(actor.chatId, 'Cari suala Reply ilə cavab verin.');
          return true;
        }
        const patch = this.parse(state.session.step!, text);
        if (!patch) {
          await this.telegram.sendTo(actor.chatId, 'Məlumat düzgün deyil və ya çox uzundur.');
          await this.promptAndSave(actor, state, { ...state.session, lastUpdateId: nextId });
          return true;
        }
        await this.advance(actor, state, patch, nextId);
        return true;
      }
    }
    if (state.session.kind === 'reject' && !action && text && !command?.startsWith('/')) {
      if (!this.matchesReply(actor, state.session, update)) {
        await this.telegram.sendTo(actor.chatId, 'Rədd səbəbi sualına Reply ilə cavab verin.');
        return true;
      }
      if (text.length > 500) {
        await this.telegram.sendTo(actor.chatId, 'Rədd səbəbi 1–500 simvol olmalıdır.');
        return true;
      }
      try {
        await this.jobs.reject(state.session.jobId!, text);
        await this.removeModerationButtons(actor.chatId, state.session.moderationMessageId);
        await this.states.save(state, idle());
        await this.telegram.sendTo(
          actor.chatId,
          `❌ #${state.session.jobId} rədd edildi.\nSəbəb: ${text}`,
          PANEL,
        );
      } catch (error) {
        await this.moderationError(actor.chatId, error);
      }
      return true;
    }
    if (action)
      await this.telegram.sendTo(
        actor.chatId,
        'Bu düymə artıq keçərli deyil. Cari addımı tamamlayın və ya admin panelini açın.',
        { inline_keyboard: [[{ text: 'Admin paneli', callback_data: 'tg:admin' }]] },
      );
    else if (state.session.kind !== 'idle')
      await this.promptAndSave(actor, state, { ...state.session, lastUpdateId: nextId });
    else await this.telegram.sendTo(actor.chatId, 'Admin panelindən seçim edin.', PANEL);
    return true;
  }

  private async advance(
    actor: AdminActor,
    state: AdminState,
    patch: Record<string, unknown>,
    updateId: number,
  ): Promise<void> {
    const next =
      state.session.step === 'work_mode' && patch.work_mode === 'remote'
        ? 'salary'
        : STEPS[STEPS.indexOf(state.session.step!) + 1];
    await this.promptAndSave(actor, state, {
      ...state.session,
      draft: { ...state.session.draft, ...patch },
      step: next,
      promptMessageId: undefined,
      lastUpdateId: updateId,
      expiresAt: this.expiry(),
    });
  }
  private async promptAndSave(
    actor: AdminActor,
    state: AdminState,
    session: AdminSession,
  ): Promise<void> {
    const cancel = { text: '↩️ Ləğv et', callback_data: `tg:cancel:${session.nonce}` };
    let message: { message_id: number };
    if (session.kind === 'create' && session.step === 'work_mode') {
      message = await this.telegram.sendTo(actor.chatId, '💼 İş rejimini seçin.', {
        inline_keyboard: [
          [
            ...[
              ['office', '🏢 Ofis'],
              ['remote', '🏠 Remote'],
              ['hybrid', '🔄 Hibrid'],
            ].map(([mode, text]) => ({
              text,
              callback_data: `tg:create:${session.nonce}:mode:${mode}`,
            })),
          ],
          [cancel],
        ],
      });
    } else if (session.kind === 'create' && session.step === 'confirm') {
      message = await this.telegram.sendTo(
        actor.chatId,
        `${formatTelegramJob(session.draft!)}\n\nElanı birbaşa aktiv etmək üçün təsdiqləyin.`,
        {
          inline_keyboard: [
            [{ text: '✅ Yarat və aktiv et', callback_data: `tg:create:${session.nonce}:publish` }],
            [cancel],
          ],
        },
      );
    } else {
      const question =
        session.kind === 'reject'
          ? `❌ #${session.jobId} üçün rədd səbəbini yazın (1–500 simvol).`
          : QUESTIONS[session.step!];
      message = await this.telegram.sendTo(actor.chatId, question, { force_reply: true });
      const buttons = [cancel];
      if (session.step === 'salary')
        buttons.unshift({
          text: 'Razılaşma yolu ilə',
          callback_data: `tg:create:${session.nonce}:salary:negotiable`,
        });
      await this.telegram.sendTo(actor.chatId, 'Əməliyyatı idarə et:', {
        inline_keyboard: [buttons],
      });
    }
    await this.states.save(state, { ...session, promptMessageId: message.message_id });
  }
  private async sendPending(chatId: number): Promise<void> {
    const jobs = await this.jobs.pending(10);
    await this.telegram.sendTo(
      chatId,
      jobs.length ? '📋 GÖZLƏYƏN VAKANSİYALAR' : '✅ Gözləyən vakansiya yoxdur.',
      PANEL,
    );
    for (const job of jobs)
      await this.telegram.sendTo(chatId, formatTelegramJob(job), moderationButtons(job.id));
  }
  private parse(step: string, text: string): Record<string, unknown> | undefined {
    const limits: Record<string, number> = {
      company_name: 160,
      title: 120,
      description: 1500,
      location_name: 250,
    };
    if (limits[step]) return text.length <= limits[step] ? { [step]: text } : undefined;
    if (step === 'salary') {
      const match = /^(\d+(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d+(?:[.,]\d{1,2})?))?$/.exec(text);
      if (!match) return undefined;
      const min = Number(match[1].replace(',', '.'));
      const max = Number((match[2] ?? match[1]).replace(',', '.'));
      return min <= max && max <= 1000000
        ? { salary_min: min, salary_max: max, salary_currency: 'AZN' }
        : undefined;
    }
    if (step === 'contact') {
      if (text.length > 300) return undefined;
      const email = text.match(/[^\s]+@[^\s]+\.[^\s]+/g);
      const phone = (email ? text.replace(email[0], '') : text).trim();
      if (email && (email.length !== 1 || !validEmail(email[0]))) return undefined;
      if (phone && (!/^\+?[\d\s()-]{7,25}$/.test(phone) || phone.replace(/\D/g, '').length < 7))
        return undefined;
      if (!phone && !email) return undefined;
      return { contact_phone: phone || null, contact_email: email?.[0] ?? null };
    }
    return undefined;
  }
  private matchesReply(actor: AdminActor, session: AdminSession, update: TelegramUpdate): boolean {
    const replyId = update.message?.reply_to_message?.message_id;
    return replyId ? replyId === session.promptMessageId : !actor.group;
  }
  private expiry(): string {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  private jobId(value: string): number | undefined {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  private async removeModerationButtons(chatId: number, messageId?: number): Promise<void> {
    if (!messageId) return;
    try {
      await this.telegram.clearButtons(chatId, messageId);
    } catch {
      this.logger.warn('Telegram moderation buttons could not be cleared');
    }
  }
  private async moderationError(chatId: number, error: unknown): Promise<void> {
    const stale = error instanceof Error && error.message.startsWith('Pending vacancy');
    await this.telegram.sendTo(
      chatId,
      stale
        ? 'Bu vakansiya artıq moderasiya edilib və ya tapılmadı.'
        : 'Əməliyyat alınmadı. Yenidən cəhd edin.',
    );
  }
}
