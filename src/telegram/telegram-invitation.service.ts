import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { TelegramStaffService } from './telegram-staff.service';
import { TelegramAdminService as TelegramTransport } from './telegram.service';
import { AdminActor, TelegramUpdate, InlineKeyboard } from './telegram.types';
import {
  ALL_PERMISSIONS,
  StaffPermission,
  STAFF_PERMISSIONS,
  canManage,
} from './staff-permissions';
export type StaffInvite = {
  id: string;
  created_by: string;
  creator_chat_id: string;
  permissions: StaffPermission[];
  status: string;
  candidate_id?: string;
  candidate_name?: string;
  candidate_username?: string;
  expires_at: string;
  fresh_claim?: boolean;
};
@Injectable()
export class TelegramInvitationService {
  private readonly logger = new Logger(TelegramInvitationService.name);
  constructor(
    private readonly db: SupabaseService,
    private readonly staff: TelegramStaffService,
    private readonly telegram: TelegramTransport,
  ) {}
  private async manager(actor: AdminActor): Promise<void> {
    const access = await this.staff.resolve(actor.userId);
    if (!access || !canManage({ ...actor, ...access })) throw new Error('İcazə yoxdur.');
  }
  async create(
    actor: AdminActor,
    permissions: StaffPermission[],
  ): Promise<{ invite: StaffInvite; url: string }> {
    await this.manager(actor);
    if (!permissions.length || !permissions.every((p) => ALL_PERMISSIONS.includes(p)))
      throw new Error('Ən azı bir icazə seçin.');
    const username = await this.telegram.botUsername();
    const token = randomBytes(24).toString('base64url');
    const value = {
      id: randomUUID(),
      token_hash: createHash('sha256').update(token).digest('hex'),
      created_by: String(actor.userId),
      creator_chat_id: String(actor.chatId),
      permissions: [...new Set(permissions)],
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    const { data, error } = await this.db.client
      .from('telegram_staff_invites')
      .insert(value)
      .select('id,created_by,creator_chat_id,permissions,status,expires_at')
      .single();
    if (error) throw error;
    return { invite: data, url: `https://t.me/${username}?start=mod_${token}` };
  }
  async handleStart(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    const match = /^\/start(?:@\w+)?\s+mod_([A-Za-z0-9_-]{32})$/.exec(message?.text?.trim() ?? '');
    if (!match) return false;
    const user = message?.from,
      chat = message?.chat;
    if (
      user?.is_bot ||
      !Number.isSafeInteger(user?.id) ||
      !user?.id ||
      chat?.type !== 'private' ||
      chat.id !== user.id
    )
      return true;
    if (String(user.id) === this.staff.ownerId() || (await this.staff.resolve(user.id))) {
      await this.telegram.sendTo(user.id, 'Sizin artıq heyət girişiniz var. Admin panelini açın.');
      return true;
    }
    const { data, error } = await this.db.client.rpc('claim_telegram_staff_invite', {
      p_hash: createHash('sha256').update(match[1]).digest('hex'),
      p_user_id: String(user.id),
      p_name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 200),
      p_username: (user.username ?? '').slice(0, 64),
    });
    if (error) throw error;
    const invite = data as StaffInvite | null;
    await this.telegram.sendTo(
      user.id,
      invite
        ? '⏳ Dəvət qəbul edildi. Admin təsdiqindən sonra moderator kimi daxil ola bilərsiniz.'
        : 'Bu dəvət keçərli deyil, istifadə olunub və ya vaxtı bitib.',
    );
    if (invite?.fresh_claim) {
      try {
        await this.telegram.sendTo(
          invite.creator_chat_id,
          this.summary(invite),
          this.reviewButtons(invite),
        );
      } catch {
        this.logger.warn(
          'Moderator invitation review notification failed; recover from invitation list',
        );
      }
    }
    return true;
  }
  async list(actor: AdminActor, page = 0): Promise<StaffInvite[]> {
    await this.manager(actor);
    const { data, error } = await this.db.client
      .from('telegram_staff_invites')
      .select(
        'id,created_by,creator_chat_id,permissions,status,candidate_id,candidate_name,candidate_username,expires_at',
      )
      .in('status', ['created', 'claimed'])
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .range(page * 5, page * 5 + 5);
    if (error) throw error;
    return data ?? [];
  }
  async finish(
    actor: AdminActor,
    id: string,
    decision: 'approve' | 'reject' | 'revoke',
  ): Promise<StaffInvite | undefined> {
    await this.manager(actor);
    const { data, error } = await this.db.client.rpc('finish_telegram_staff_invite', {
      p_id: id,
      p_actor: String(actor.userId),
      p_owner: this.staff.ownerId() ?? '',
      p_decision: decision,
    });
    if (error) throw error;
    if (data?.candidate_id && decision !== 'revoke') {
      try {
        await this.telegram.sendTo(
          data.candidate_id,
          decision === 'approve'
            ? '✅ Moderator kimi təsdiqləndiniz. 🏠 Admin paneli düyməsi ilə və ya Start basaraq daxil olun.'
            : 'Dəvət müraciətiniz təsdiqlənmədi.',
          decision === 'approve'
            ? {
                keyboard: [[{ text: '🏠 Admin paneli' }]],
                resize_keyboard: true,
                is_persistent: true,
                one_time_keyboard: false,
              }
            : undefined,
        );
      } catch {
        this.logger.warn('Moderator invitation result notification failed');
      }
    }
    return data ?? undefined;
  }
  summary(i: StaffInvite): string {
    const permissions = i.permissions.map((p) => STAFF_PERMISSIONS[p]).join('\n');
    return `👥 Moderator dəvəti\n${i.candidate_name || 'Hələ qoşulmayıb'}${i.candidate_username ? ' • @' + i.candidate_username : ''}\n${i.candidate_id ? 'Telegram ID: ' + i.candidate_id + '\n' : ''}\nİcazələr:\n${permissions}\n\nAd və username kimlik təsdiqi deyil. Tanıdığınız şəxsin qoşulduğunu yoxlayıb təsdiqləyin.`;
  }
  reviewButtons(i: StaffInvite): InlineKeyboard {
    return {
      inline_keyboard: [
        ...(i.status === 'claimed'
          ? [
              [
                { text: '✅ Moderator kimi təsdiqlə', callback_data: `invite:approve:${i.id}` },
                { text: '❌ Rədd et', callback_data: `invite:reject:${i.id}` },
              ],
            ]
          : []),
        [{ text: '🚫 Dəvəti ləğv et', callback_data: `invite:revoke:${i.id}` }],
      ],
    };
  }
}
