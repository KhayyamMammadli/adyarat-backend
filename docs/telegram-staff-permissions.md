# Telegram staff roles

The configured private TELEGRAM_ADMIN_CHAT_ID remains the protected superadmin identity. If notifications target a group, configure TELEGRAM_SUPERADMIN_USER_ID once with the owner's private user ID. Never use a bot token as a user ID.

Asim's explicitly supplied user ID 5920740941 is seeded as admin by the migration. Other existing TELEGRAM_ADMIN_USER_IDS retain admin access during transition. A stored inactive staff entry overrides that legacy allowlist. New moderators do not require environment edits or deployment.

Superadmin can add admins and moderators, edit permission selections, and revoke/reactivate staff. Admins can manage moderators only; they cannot alter the superadmin, themselves, or other admins. Moderators cannot manage staff.

Open Admin panel → Moderatorlar / heyət → Moderator əlavə et → enter numeric Telegram user ID → toggle multiple checkboxes → Yadda saxla. Toggle selections are a draft until Save. Choose an existing staff member to edit permissions, revoke, or reactivate. Admin role has all vacancy/business/statistics permissions. All management uses buttons; only the ID is typed. The new staff member must open the bot and press Start.

Permissions: approve, reject, create, businesses, pending, statistics. Permission checks cover callbacks, legacy vacancy commands, creation/rejection/business verification continuation, listing, and statistics. Menus and pending vacancy cards hide disallowed operations. Legacy advertising diagnostic commands remain superadmin-only. Every webhook resolves staff access again; inactive entries cannot operate. Webhook secret and configured group restrictions remain mandatory. Telegram sessions remain namespaced by chat and user, separate from WhatsApp.

A new service-role-only public.telegram_staff table stores roles, permissions, active state, and last editor/time. RLS is enabled with no public policies; anon/authenticated have no table grants. The migration does not change or delete WhatsApp profiles or vacancies. Supabase service credentials remain server-side.

Apply supabase/migrations/20261007102134_telegram_staff_permissions.sql before deploying this change. Missing ACL table fails closed for non-owner access. The superadmin retains private access independently of ACL data. No token changes are required. New moderation notifications still go to the existing configured Telegram chat; other staff can open their permitted pending queues in their own chats.

Validation: npm run typecheck, npm test (includes build). SQL tests use PGlite to verify schema constraints, Asim seed, service-role access and client denial. Tests cover multi-selection, deselection, Save, restart, stale buttons, revocation, role boundaries, restricted menus/callbacks/commands, and permission removal during unfinished flows.
