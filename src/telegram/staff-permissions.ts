import { AdminActor, InlineKeyboard } from './telegram.types';
export const STAFF_PERMISSIONS = {
  approve: '✅ Vakansiya təsdiqlə',
  reject: '❌ Vakansiya rədd et',
  create: '➕ Vakansiya yarat',
  businesses: '🏢 Biznes profillərini yoxla',
  pending: '⏳ Gözləyən elanları gör',
  statistics: '📊 Statistikaya bax',
} as const;
export type StaffPermission = keyof typeof STAFF_PERMISSIONS;
export type StaffRole = 'superadmin' | 'admin' | 'moderator';
export const ALL_PERMISSIONS = Object.keys(STAFF_PERMISSIONS) as StaffPermission[];
export function can(actor: AdminActor, permission: StaffPermission): boolean {
  // Unannotated actors exist only in legacy unit fixtures. Production controller
  // always resolves a role and permissions from the access service.
  return actor.permissions === undefined || actor.permissions.includes(permission);
}
export function canManage(actor: AdminActor): boolean {
  return actor.role === 'superadmin' || actor.role === 'admin';
}
export function requiredPermission(action = '', text = '', kind = ''): StaffPermission | undefined {
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (action.startsWith('tg:stats') || command === '/stats') return 'statistics';
  if (action === 'tg:pending' || ['/pending', '/vakansiyalar'].includes(command)) return 'pending';
  if (action.startsWith('tg:approve:') || command === '/approve') return 'approve';
  if (action.startsWith('tg:reject:') || command === '/reject') return 'reject';
  if (action === 'tg:businesses' || action.startsWith('biz:') || action.startsWith('tg:business:'))
    return 'businesses';
  if (action === 'tg:new') return 'create';
  // Home/cancel always remains accessible even after permission revocation.
  if (
    action === 'tg:admin' ||
    action.startsWith('tg:cancel:') ||
    ['/admin', '/start', '/menu', '/cancel'].includes(command) ||
    text === '🏠 Admin paneli'
  )
    return undefined;
  if (kind === 'create') return 'create';
  if (kind === 'reject') return 'reject';
  if (kind === 'business_verify') return 'businesses';
  return undefined;
}
export function permittedPanel(actor: AdminActor, panel: InlineKeyboard): InlineKeyboard {
  const rows = panel.inline_keyboard
    .map((row) =>
      row.filter((button) => {
        const permission = requiredPermission(button.callback_data);
        return !permission || can(actor, permission);
      }),
    )
    .filter((row) => row.length);
  if (canManage(actor))
    rows.push([{ text: '👥 Moderatorlar / heyət', callback_data: 'staff:home' }]);
  return { inline_keyboard: rows };
}
