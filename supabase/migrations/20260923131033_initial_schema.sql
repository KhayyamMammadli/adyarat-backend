create extension if not exists pgcrypto;

create table public.wa_contacts (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,
  profile_name text,
  state text not null default 'new'
    check (state in ('new', 'awaiting_prompt', 'processing')),
  pending_image_path text,
  pending_image_mime text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null unique,
  contact_id uuid not null references public.wa_contacts(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  type text not null,
  content jsonb not null default '{}'::jsonb,
  status text not null,
  created_at timestamptz not null default now()
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.wa_contacts(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  provider text not null,
  prompt text not null check (char_length(prompt) between 5 and 1000),
  input_storage_path text not null,
  input_mime_type text not null,
  output_storage_path text,
  provider_job_id text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index webhook_events_pending_idx
  on public.webhook_events (created_at)
  where status = 'pending';

create index generation_jobs_queue_idx
  on public.generation_jobs (created_at)
  where status = 'queued';

create index generation_jobs_contact_idx
  on public.generation_jobs (contact_id, created_at desc);

create index wa_messages_contact_idx
  on public.wa_messages (contact_id, created_at desc);

alter table public.wa_contacts enable row level security;
alter table public.wa_messages enable row level security;
alter table public.webhook_events enable row level security;
alter table public.generation_jobs enable row level security;

revoke all on table public.wa_contacts from anon, authenticated;
revoke all on table public.wa_messages from anon, authenticated;
revoke all on table public.webhook_events from anon, authenticated;
revoke all on table public.generation_jobs from anon, authenticated;

grant select, insert, update, delete on table public.wa_contacts to service_role;
grant select, insert, update, delete on table public.wa_messages to service_role;
grant select, insert, update, delete on table public.webhook_events to service_role;
grant select, insert, update, delete on table public.generation_jobs to service_role;
