import { Optional } from '@nestjs/common';
import { TelegramInvitationService } from './telegram-invitation.service';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TelegramStaffService } from './telegram-staff.service';
import { TelegramAdminStateService, AdminSession } from './telegram-admin-state.service';
import { TelegramAdminService as TelegramTransport } from './telegram.service';
import { AdminActor, TelegramUpdate } from './telegram.types';
import {
  ALL_PERMISSIONS,
  STAFF_PERMISSIONS,
  StaffPermission,
  canManage,
} from './staff-permissions';
@Injectable()
export class TelegramStaffMenuService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly staff: TelegramStaffService,
    private readonly states: TelegramAdminStateService,
    private readonly telegram: TelegramTransport,
    @Optional() private readonly invitations?: TelegramInvitationService,
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
    // Vacancy callbacks cannot belong to a staff draft; avoid a second state
    // lookup on the busiest listing/moderation paths.
    const callback = update.callback_query?.data;
    if (callback && !callback.startsWith('staff:') && !callback.startsWith('invite:')) return false;
    const access = await this.staff.resolve(actor.userId);
    if (!access) return true;
    actor = { ...actor, ...access };
    const action = update.callback_query?.data ?? '';
    const text = update.message?.text?.trim() ?? '';
    if (
      action === 'tg:admin' ||
      text === '🏠 Admin paneli' ||
      /^\/(admin|start|menu|cancel)(@\w+)?$/.test(text)
    )
      return false;
    const state = await this.states.load(actor);
    if (
      !action.startsWith('staff:') &&
      !action.startsWith('invite:') &&
      state.session.kind !== 'staff'
    )
      return false;
    if (!canManage(actor)) {
      await this.telegram.sendTo(actor.chatId, 'Heyəti idarə etməyə icazəniz yoxdur.');
      return true;
    }
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id! <= state.session.lastUpdateId) return true;
    const idle: AdminSession = { kind: 'idle', lastUpdateId: id! };
    const home = {
      inline_keyboard: [
        [
          { text: '👥 Heyət', callback_data: 'staff:home' },
          { text: 'Əsas menyu', callback_data: 'tg:admin' },
        ],
      ],
    };
    if (this.invitations && (action === 'invite:list' || /^invite:list:\d{1,6}$/.test(action))) {
      const page = action === 'invite:list' ? 0 : Number(action.split(':')[2]);
      const rows = await this.invitations.list(actor, page);
      for (const invite of rows.slice(0, 5))
        await this.telegram.sendTo(
          actor.chatId,
          this.invitations.summary(invite),
          this.invitations.reviewButtons(invite),
        );
      const buttons = [];
      if (page) buttons.push({ text: '⬅️ Geri', callback_data: `invite:list:${page - 1}` });
      if (rows.length > 5)
        buttons.push({ text: 'Növbəti ➡️', callback_data: `invite:list:${page + 1}` });
      await this.telegram.sendTo(
        actor.chatId,
        rows.length ? 'Gözləyən dəvətlər' : 'Gözləyən dəvət yoxdur.',
        { inline_keyboard: [...(buttons.length ? [buttons] : []), ...home.inline_keyboard] },
      );
      await this.states.save(state, idle);
      return true;
    }
    const decision =
      /^invite:(approve|reject|revoke):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
        action,
      );
    if (decision && this.invitations) {
      const changed = await this.invitations.finish(
        actor,
        decision[2],
        decision[1] as 'approve' | 'reject' | 'revoke',
      );
      await this.states.save(state, idle);
      await this.telegram.sendTo(
        actor.chatId,
        changed
          ? decision[1] === 'approve'
            ? '✅ Moderator təsdiqləndi.'
            : 'Dəvət bağlandı.'
          : 'Dəvət artıq bağlanıb, şəxs heyətdədir, yaradıcı icazəsini itirib və ya vaxtı bitib.',
        home,
      );
      return true;
    }
    if (action === 'staff:invite' && this.invitations) {
      const session: AdminSession = {
        kind: 'staff',
        step: 'permissions',
        nonce: randomBytes(6).toString('hex'),
        draft: { role: 'moderator', invitation: true, permissions: [] },
        lastUpdateId: id!,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await this.states.save(state, session);
      await this.show(actor, session);
      return true;
    }
    if (action === 'staff:home' || /^staff:list:\d{1,6}$/.test(action)) {
      const page = action === 'staff:home' ? 0 : Number(action.split(':')[2]);
      const rows = await this.staff.list(page);
      const buttons = rows
        .slice(0, 6)
        .filter((row) => actor.role === 'superadmin' || row.role === 'moderator')
        .map((row) => [
          {
            text: `${row.active ? '✅' : '🚫'} ${row.user_id} • ${row.role}`,
            callback_data: `staff:edit:${row.user_id}`,
          },
        ]);
      if (this.invitations) {
        buttons.push([{ text: '🔗 Moderator dəvət et', callback_data: 'staff:invite' }]);
        buttons.push([{ text: '⏳ Gözləyən dəvətlər', callback_data: 'invite:list' }]);
      }
      buttons.push([
        { text: '➕ ID ilə moderator əlavə et', callback_data: 'staff:add:moderator' },
      ]);
      if (actor.role === 'superadmin')
        buttons.push([{ text: '➕ Admin əlavə et', callback_data: 'staff:add:admin' }]);
      const nav = [];
      if (page) nav.push({ text: '⬅️ Geri', callback_data: `staff:list:${page - 1}` });
      if (rows.length > 6)
        nav.push({ text: 'Növbəti ➡️', callback_data: `staff:list:${page + 1}` });
      if (nav.length) buttons.push(nav);
      buttons.push([{ text: 'Əsas menyu', callback_data: 'tg:admin' }]);
      await this.states.save(state, idle);
      await this.telegram.sendTo(
        actor.chatId,
        '👥 Heyət • əlavə etmək və ya icazələri dəyişmək üçün seçin.',
        { inline_keyboard: buttons },
      );
      return true;
    }
    if (
      action === 'staff:add:moderator' ||
      (action === 'staff:add:admin' && actor.role === 'superadmin')
    ) {
      const prompt = await this.telegram.sendTo(
        actor.chatId,
        'Əlavə edəcəyiniz şəxsin rəqəmli Telegram user ID-sini yazın.',
        { force_reply: true, selective: true },
      );
      await this.states.save(state, {
        kind: 'staff',
        step: 'user_id',
        nonce: randomBytes(6).toString('hex'),
        draft: { role: action.endsWith(':admin') ? 'admin' : 'moderator', permissions: [] },
        promptMessageId: prompt?.message_id,
        lastUpdateId: id!,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      return true;
    }
    const edit = /^staff:edit:([1-9]\d{0,15})$/.exec(action);
    if (edit) {
      const target = await this.staff.get(edit[1]);
      if (
        !target ||
        (actor.role !== 'superadmin' && target.role !== 'moderator') ||
        edit[1] === this.staff.ownerId()
      ) {
        await this.telegram.sendTo(actor.chatId, 'Bu şəxsi idarə etməyə icazəniz yoxdur.', home);
        return true;
      }
      const session: AdminSession = {
        kind: 'staff',
        step: 'permissions',
        nonce: randomBytes(6).toString('hex'),
        draft: {
          userId: target.user_id,
          role: target.role,
          permissions: target.permissions,
          active: target.active,
        },
        lastUpdateId: id!,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await this.states.save(state, session);
      await this.show(actor, session);
      return true;
    }
    let session = state.session;
    if (
      session.kind !== 'staff' ||
      !session.expiresAt ||
      session.expiresAt <= new Date().toISOString()
    ) {
      await this.states.save(state, idle);
      await this.telegram.sendTo(
        actor.chatId,
        'Seçimin vaxtı bitib. Heyət menyusunu yenidən açın.',
        home,
      );
      return true;
    }
    if (!action && session.step === 'user_id') {
      if (actor.group && update.message?.reply_to_message?.message_id !== session.promptMessageId)
        return true;
      if (
        !/^[1-9]\d{0,15}$/.test(text) ||
        !Number.isSafeInteger(Number(text)) ||
        text === this.staff.ownerId()
      ) {
        await this.telegram.sendTo(
          actor.chatId,
          'Düzgün rəqəmli user ID yazın. Superadmin dəyişdirilə bilməz.',
        );
        return true;
      }
      const existing = await this.staff.get(text);
      if (existing) {
        await this.telegram.sendTo(
          actor.chatId,
          'Bu şəxs artıq siyahıdadır. Heyət menyusundan onu seçin.',
          home,
        );
        await this.states.save(state, idle);
        return true;
      }
      session = {
        ...session,
        step: 'permissions',
        draft: { ...session.draft, userId: text, active: true },
        lastUpdateId: id!,
      };
      await this.states.save(state, session);
      await this.show(actor, session);
      return true;
    }
    const prefix = `staff:${session.nonce}:`;
    if (!action.startsWith(prefix)) {
      await this.telegram.sendTo(
        actor.chatId,
        'Köhnə düymədir. Cari icazə menyusundan istifadə edin.',
        home,
      );
      return true;
    }
    const choice = action.slice(prefix.length);
    if (
      ALL_PERMISSIONS.includes(choice as StaffPermission) &&
      session.draft?.role === 'moderator'
    ) {
      const permissions = new Set<StaffPermission>(session.draft.permissions ?? []);
      if (permissions.has(choice as StaffPermission)) permissions.delete(choice as StaffPermission);
      else permissions.add(choice as StaffPermission);
      session = {
        ...session,
        draft: { ...session.draft, permissions: [...permissions] },
        lastUpdateId: id!,
      };
      await this.states.save(state, session);
      await this.show(actor, session);
      return true;
    }
    if (choice === 'link' && session.draft?.invitation && this.invitations) {
      if (!session.draft.permissions?.length) {
        await this.telegram.sendTo(actor.chatId, 'Ən azı bir icazə seçin.');
        return true;
      }
      const result = await this.invitations.create(actor, session.draft.permissions);
      await this.states.save(state, idle);
      await this.telegram.sendTo(
        actor.chatId,
        `🔗 Linki dəvət etdiyiniz şəxsə göndərin:\n${result.url}\n\n24 saat etibarlıdır. Şəxs Start basdıqdan sonra onun məlumatlarına baxıb təsdiqləyin.`,
        this.invitations.reviewButtons(result.invite),
      );
      return true;
    }
    if ((choice === 'save' || choice === 'revoke') && !session.draft?.invitation) {
      try {
        await this.staff.save(
          actor,
          String(session.draft?.userId),
          session.draft?.role,
          session.draft?.permissions ?? [],
          choice === 'save',
        );
        await this.states.save(state, idle);
        await this.telegram.sendTo(
          actor.chatId,
          choice === 'save'
            ? '✅ Rol və seçilmiş icazələr saxlanıldı. Şəxs botda Start basa bilər.'
            : '🚫 İcazə ləğv edildi.',
          home,
        );
      } catch {
        await this.telegram.sendTo(
          actor.chatId,
          'Əməliyyat alınmadı və ya buna icazəniz yoxdur.',
          home,
        );
      }
      return true;
    }
    return true;
  }
  private async show(actor: AdminActor, session: AdminSession): Promise<void> {
    const selected = session.draft?.permissions ?? [];
    const buttons =
      session.draft?.role === 'moderator'
        ? ALL_PERMISSIONS.map((permission) => [
            {
              text: `${selected.includes(permission) ? '☑️' : '⬜'} ${STAFF_PERMISSIONS[permission]}`,
              callback_data: `staff:${session.nonce}:${permission}`,
            },
          ])
        : [];
    if (session.draft?.invitation)
      buttons.push([
        { text: '🔗 Dəvət linki yarat', callback_data: `staff:${session.nonce}:link` },
      ]);
    else {
      buttons.push([
        { text: '💾 Yadda saxla / aktiv et', callback_data: `staff:${session.nonce}:save` },
      ]);
      buttons.push([
        { text: '🚫 İcazəni ləğv et', callback_data: `staff:${session.nonce}:revoke` },
      ]);
    }
    buttons.push([{ text: 'Ləğv et / geri', callback_data: 'staff:home' }]);
    await this.telegram.sendTo(
      actor.chatId,
      `👤 ${session.draft?.invitation ? 'Yeni dəvət' : session.draft?.userId} • ${session.draft?.role}\nBir neçə icazə seçə bilərsiniz. Seçimlər təsdiqlənənədək tətbiq edilmir.`,
      { inline_keyboard: buttons },
    );
  }
}
