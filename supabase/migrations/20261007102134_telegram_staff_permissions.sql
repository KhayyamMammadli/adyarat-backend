-- Backend-owned Telegram ACL. No WhatsApp users or vacancies are modified.
create table public.telegram_staff (
  user_id text primary key check (user_id ~ '^[1-9][0-9]{0,15}$'),
  role text not null check (role in ('admin', 'moderator')),
  permissions text[] not null default '{}',
  active boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (permissions <@ array['approve','reject','create','businesses','pending','statistics']::text[])
);
alter table public.telegram_staff enable row level security;
revoke all on public.telegram_staff from public, anon, authenticated;
grant select, insert, update on public.telegram_staff to service_role;
-- Explicitly requested admin identity; this is a public Telegram ID, not a secret.
insert into public.telegram_staff(user_id,role,permissions)
values ('5920740941','admin',array['approve','reject','create','businesses','pending','statistics']);
