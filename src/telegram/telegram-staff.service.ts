import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { AdminActor } from './telegram.types';
import { ALL_PERMISSIONS, StaffPermission, StaffRole, canManage } from './staff-permissions';
export type StaffEntry = {
  user_id: string;
  role: 'admin' | 'moderator';
  permissions: StaffPermission[];
  active: boolean;
  updated_by?: string;
};
@Injectable()
export class TelegramStaffService {
  constructor(
    private readonly db: SupabaseService,
    private readonly config: ConfigService,
  ) {}
  ownerId(): string | undefined {
    const id =
      this.config.get<string>('TELEGRAM_SUPERADMIN_USER_ID')?.trim() ??
      this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID')?.trim();
    return id && /^[1-9]\d*$/.test(id) ? id : undefined;
  }
  async resolve(userId: number): Promise<Pick<AdminActor, 'role' | 'permissions'> | undefined> {
    if (String(userId) === this.ownerId())
      return { role: 'superadmin', permissions: [...ALL_PERMISSIONS] };
    const { data, error } = await this.db.client
      .from('telegram_staff')
      .select('*')
      .eq('user_id', String(userId))
      .maybeSingle();
    if (error) throw error; // Fail closed, including missing migration.
    if (data)
      return data.active
        ? {
            role: data.role,
            permissions: data.role === 'admin' ? [...ALL_PERMISSIONS] : data.permissions,
          }
        : undefined;
    // Existing allowlist works during transition; a revoked DB row takes precedence.
    const legacy =
      this.config
        .get<string>('TELEGRAM_ADMIN_USER_IDS')
        ?.split(',')
        .map((id) => id.trim()) ?? [];
    return legacy.includes(String(userId))
      ? { role: 'admin', permissions: [...ALL_PERMISSIONS] }
      : undefined;
  }
  async list(page = 0): Promise<StaffEntry[]> {
    const { data, error } = await this.db.client
      .from('telegram_staff')
      .select('*')
      .order('user_id')
      .range(page * 6, page * 6 + 6);
    if (error) throw error;
    return data ?? [];
  }
  async get(userId: string): Promise<StaffEntry | undefined> {
    const { data, error } = await this.db.client
      .from('telegram_staff')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data ?? undefined;
  }
  async save(
    actor: AdminActor,
    userId: string,
    role: StaffRole,
    permissions: StaffPermission[],
    active = true,
  ): Promise<void> {
    const access = await this.resolve(actor.userId);
    if (!access) throw new Error('İcazə ləğv edilib.');
    actor = { ...actor, ...access };
    if (
      !canManage(actor) ||
      !/^[1-9]\d{0,15}$/.test(userId) ||
      !Number.isSafeInteger(Number(userId)) ||
      userId === this.ownerId() ||
      role === 'superadmin'
    )
      throw new Error('İcazə yoxdur və ya ID düzgün deyil.');
    if (!permissions.every((p) => ALL_PERMISSIONS.includes(p)))
      throw new Error('İcazə düzgün deyil.');
    const target = await this.get(userId);
    const legacyAdmin = this.config
      .get<string>('TELEGRAM_ADMIN_USER_IDS')
      ?.split(',')
      .map((id) => id.trim())
      .includes(userId);
    if (
      actor.role !== 'superadmin' &&
      (role !== 'moderator' ||
        target?.role === 'admin' ||
        legacyAdmin ||
        userId === String(actor.userId))
    )
      throw new Error('Admin yalnız moderatorları idarə edə bilər.');
    const record = {
      user_id: userId,
      role,
      permissions: role === 'admin' ? [...ALL_PERMISSIONS] : [...new Set(permissions)],
      active,
      updated_by: String(actor.userId),
      updated_at: new Date().toISOString(),
    };
    // Conditional writes prevent a concurrent promotion from being overwritten
    // by an admin who may manage only moderators.
    const table = this.db.client.from('telegram_staff');
    const query =
      actor.role === 'superadmin'
        ? table.upsert(record, { onConflict: 'user_id' })
        : target
          ? table.update(record).eq('user_id', userId).eq('role', 'moderator')
          : table.insert(record);
    const { data, error } = await query.select('user_id').single();
    if (error || !data) throw error ?? new Error('Heyət dəyişib. Yenidən yoxlayın.');
  }
}
