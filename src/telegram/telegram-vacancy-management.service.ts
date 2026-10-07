import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { TelegramStaffService } from './telegram-staff.service';
import { TelegramAdminStateService, AdminSession } from './telegram-admin-state.service';
import { TelegramAdminService } from './telegram.service';
import { AdminActor, TelegramUpdate } from './telegram.types';
import { can } from './staff-permissions';
import {
  EDIT_FIELDS,
  editValue,
  validEditedJob,
  publicationLabel,
} from '../job-agent/vacancy-lifecycle';
import { validCoordinates } from '../job-agent/vacancy-validation';
@Injectable()
export class TelegramVacancyManagementService {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: SupabaseService,
    private readonly staff: TelegramStaffService,
    private readonly states: TelegramAdminStateService,
    private readonly telegram: TelegramAdminService,
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
  private async process(actor: AdminActor, u: TelegramUpdate): Promise<boolean> {
    const action = u.callback_query?.data ?? '',
      text = u.message?.text?.trim() ?? '';
    if (
      action === 'tg:admin' ||
      text === '🏠 Admin paneli' ||
      /^\/(start|admin|menu|cancel)(@\w+)?$/.test(text)
    )
      return false;
    if (action && !action.startsWith('editjob:')) return false;
    const state = await this.states.load(actor);
    if (!action.startsWith('editjob:') && state.session.kind !== 'edit') return false;
    const access = await this.staff.resolve(actor.userId);
    if (!access || !can({ ...actor, ...access }, 'edit')) {
      await this.telegram.sendTo(actor.chatId, 'Elan redaktəsinə icazəniz yoxdur.');
      return true;
    }
    const id = u.update_id;
    if (!Number.isSafeInteger(id) || id! <= state.session.lastUpdateId) return true;
    const home = { inline_keyboard: [[{ text: 'Əsas menyu', callback_data: 'tg:admin' }]] };
    const page = /^editjob:list:(\d{1,6})$/.exec(action);
    if (page) {
      const n = Number(page[1]);
      const r = await this.db.client
        .from('jobs')
        .select('*')
        .contains('metadata', { telegram_admin_user_id: actor.userId })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(n * 5, n * 5 + 5);
      if (r.error) throw r.error;
      const rows = (r.data ?? []).slice(0, 5).map((j) => [
        {
          text: `#${j.id} ${String(j.title).slice(0, 35)} • ${j.status}`,
          callback_data: `editjob:open:${j.id}`,
        },
      ]);
      const nav = [];
      if (n) nav.push({ text: '⬅️ Geri', callback_data: `editjob:list:${n - 1}` });
      if ((r.data?.length ?? 0) > 5)
        nav.push({ text: 'Növbəti ➡️', callback_data: `editjob:list:${n + 1}` });
      if (nav.length) rows.push(nav);
      rows.push(...home.inline_keyboard);
      await this.states.save(state, { kind: 'idle', lastUpdateId: id! });
      await this.telegram.sendTo(actor.chatId, '✏️ Yaratdığınız elanları redaktə edin.', {
        inline_keyboard: rows,
      });
      return true;
    }
    const open = /^editjob:open:(\d+)$/.exec(action);
    if (open) {
      const r = await this.db.client
        .from('jobs')
        .select('*')
        .eq('id', Number(open[1]))
        .contains('metadata', { telegram_admin_user_id: actor.userId })
        .maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) {
        await this.telegram.sendTo(actor.chatId, 'Elan tapılmadı.', home);
        return true;
      }
      const session: AdminSession = {
        kind: 'edit',
        nonce: randomBytes(6).toString('hex'),
        jobId: r.data.id,
        jobRevision: r.data.revision ?? 1,
        step: 'menu',
        draft: { job: r.data, patch: {} },
        lastUpdateId: id!,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await this.states.save(state, session);
      await this.menu(actor, session);
      return true;
    }
    let s = state.session;
    if (s.kind !== 'edit' || !s.expiresAt || s.expiresAt <= new Date().toISOString()) {
      await this.states.save(state, { kind: 'idle', lastUpdateId: id! });
      await this.telegram.sendTo(actor.chatId, 'Redaktənin vaxtı bitib.', home);
      return true;
    }
    const prefix = `editjob:${s.nonce}:`;
    const choice = action.startsWith(prefix) ? action.slice(prefix.length) : '';
    if (action && !choice) {
      await this.telegram.sendTo(actor.chatId, 'Köhnə redaktə düyməsidir.', home);
      return true;
    }
    if (choice === 'save') {
      if (!Object.keys(s.draft?.patch ?? {}).length) {
        await this.telegram.sendTo(actor.chatId, 'Hələ dəyişiklik etməmisiniz.');
        return true;
      }
      if (!validEditedJob(s.draft?.job)) {
        await this.telegram.sendTo(actor.chatId, 'Ofis/Hibrid üçün lokasiya göndərin.');
        return true;
      }
      const r = await this.db.client.rpc('save_vacancy_revision', {
        p_job: s.jobId,
        p_profile: null,
        p_telegram_user: String(actor.userId),
        p_revision: s.jobRevision,
        p_patch: s.draft?.patch,
      });
      if (r.error) throw r.error;
      await this.states.save(state, { kind: 'idle', lastUpdateId: id! });
      await this.telegram.sendTo(
        actor.chatId,
        r.data
          ? `✅ #${r.data.id} yeniləndi. ${publicationLabel(r.data)}`
          : 'Elan dəyişib və ya müddəti bitib. Yenidən açın.',
        home,
      );
      return true;
    }
    let patch: any;
    if (
      (choice === 'now' && s.step !== 'scheduled_at') ||
      (choice === 'skip' && !['contact_phone', 'contact_email', 'salary'].includes(s.step!))
    )
      return true;
    if (choice === 'now') patch = { scheduled_at: null };
    else if (choice === 'skip')
      patch =
        s.step === 'contact_phone'
          ? { contact_phone: null }
          : s.step === 'contact_email'
            ? { contact_email: null }
            : { salary_min: null, salary_max: null };
    else if (['office', 'remote', 'hybrid'].includes(choice) && s.step === 'work_mode')
      patch = { work_mode: choice };
    else if (choice.startsWith('cat_')) {
      const category = Number(choice.slice(4));
      const r = await this.db.client
        .from('job_categories')
        .select('id')
        .eq('id', category)
        .eq('is_active', true)
        .maybeSingle();
      if (r.error) throw r.error;
      if (r.data) patch = { category_id: category };
    } else if (choice.startsWith('cats_')) {
      await this.categories(actor, s, Number(choice.slice(5)));
      return true;
    } else if (choice in EDIT_FIELDS) {
      s = { ...s, step: choice, lastUpdateId: id! };
      await this.states.save(state, s);
      await this.prompt(actor, s);
      return true;
    } else if (!action && s.step !== 'menu') {
      if (actor.group && u.message?.reply_to_message?.message_id !== s.promptMessageId) {
        await this.telegram.sendTo(actor.chatId, 'Cari suala Reply edin.');
        return true;
      }
      const location = u.message?.venue?.location ?? u.message?.location;
      if (s.step === 'location_pin' && validCoordinates(location))
        patch = {
          latitude: location!.latitude,
          longitude: location!.longitude,
          ...(u.message?.venue?.address
            ? { location_name: u.message.venue.address.slice(0, 250) }
            : {}),
        };
      else patch = editValue(s.step!, text, s.draft?.job);
    }
    if (!patch) {
      await this.telegram.sendTo(actor.chatId, 'Cari sahə üçün düzgün məlumat göndərin.', home);
      return true;
    }
    s = {
      ...s,
      step: 'menu',
      draft: { job: { ...s.draft?.job, ...patch }, patch: { ...s.draft?.patch, ...patch } },
      lastUpdateId: id!,
    };
    await this.states.save(state, s);
    await this.menu(actor, s);
    return true;
  }
  private async menu(a: AdminActor, s: AdminSession) {
    const rows = Object.entries(EDIT_FIELDS).map(([field, title]) => [
      { text: title, callback_data: `editjob:${s.nonce}:${field}` },
    ]);
    rows.push(
      [{ text: '💾 Saxla', callback_data: `editjob:${s.nonce}:save` }],
      [{ text: 'Ləğv et', callback_data: 'tg:admin' }],
    );
    await this.telegram.sendTo(
      a.chatId,
      `✏️ #${s.jobId} • ${s.draft?.job.title}\n${publicationLabel(s.draft?.job)}\nSaxla basılana qədər dəyişiklik tətbiq edilmir.`,
      { inline_keyboard: rows },
    );
  }
  private async categories(a: AdminActor, s: AdminSession, page: number) {
    const r = await this.db.client
      .from('job_categories')
      .select('id,name')
      .eq('is_active', true)
      .order('id')
      .range(page * 6, page * 6 + 6);
    if (r.error) throw r.error;
    const rows = (r.data ?? [])
      .slice(0, 6)
      .map((c) => [{ text: String(c.name), callback_data: `editjob:${s.nonce}:cat_${c.id}` }]);
    const nav = [];
    if (page) nav.push({ text: '⬅️ Geri', callback_data: `editjob:${s.nonce}:cats_${page - 1}` });
    if ((r.data?.length ?? 0) > 6)
      nav.push({ text: 'Növbəti ➡️', callback_data: `editjob:${s.nonce}:cats_${page + 1}` });
    if (nav.length) rows.push(nav);
    await this.telegram.sendTo(a.chatId, 'Kateqoriyanı seçin.', { inline_keyboard: rows });
  }
  private async prompt(a: AdminActor, s: AdminSession) {
    if (s.step === 'category_id') {
      await this.categories(a, s, 0);
      return;
    }
    const row =
      s.step === 'work_mode'
        ? ['office', 'remote', 'hybrid'].map((m) => ({
            text: m,
            callback_data: `editjob:${s.nonce}:${m}`,
          }))
        : s.step === 'scheduled_at'
          ? [{ text: 'Dərhal yayımla', callback_data: `editjob:${s.nonce}:now` }]
          : ['salary', 'contact_phone', 'contact_email'].includes(s.step!)
            ? [{ text: 'Boş saxla', callback_data: `editjob:${s.nonce}:skip` }]
            : [];
    const q =
      s.step === 'scheduled_at'
        ? 'Bakı vaxtı ilə gələcək tarix: DD.MM.YYYY HH:mm. Elanın 28 günlük son tarixindən əvvəl olmalıdır.'
        : s.step === 'location_pin'
          ? '📎 → Location ilə məkan göndərin.'
          : `${EDIT_FIELDS[s.step as keyof typeof EDIT_FIELDS]} üçün yeni məlumat yazın.`;
    const message = await this.telegram.sendTo(a.chatId, q, { force_reply: true, selective: true });
    s.promptMessageId = message.message_id;
    // Persist prompt ID using the latest state after the field transition.
    const state = await this.states.load(a);
    await this.states.save(state, s);
    if (row.length) await this.telegram.sendTo(a.chatId, 'Seçimlər', { inline_keyboard: [row] });
  }
}
