begin;

-- 1 dəqiqəlik video üçün WhatsApp istifadəçi vəziyyətləri
alter table public.wa_contacts
  add column if not exists selected_video_duration_seconds integer not null default 10,
  add column if not exists pending_image_paths jsonb not null default '[]'::jsonb,
  add column if not exists pending_image_mimes jsonb not null default '[]'::jsonb;

alter table public.wa_contacts
  drop constraint if exists wa_contacts_selected_video_duration_seconds_check,
  drop constraint if exists wa_contacts_pending_image_paths_check,
  drop constraint if exists wa_contacts_pending_image_mimes_check,
  drop constraint if exists wa_contacts_state_check;

alter table public.wa_contacts
  add constraint wa_contacts_selected_video_duration_seconds_check
    check (selected_video_duration_seconds in (10, 60)),
  add constraint wa_contacts_pending_image_paths_check
    check (jsonb_typeof(pending_image_paths) = 'array'),
  add constraint wa_contacts_pending_image_mimes_check
    check (jsonb_typeof(pending_image_mimes) = 'array'),
  add constraint wa_contacts_state_check
    check (
      state in (
        'new',
        'awaiting_prompt',
        'awaiting_ad_copy_brief',
        'awaiting_voice_ad_brief',
        'awaiting_support_message',
        'awaiting_video_duration',
        'awaiting_long_video_images',
        'awaiting_long_video_brief',
        'processing'
      )
    );

-- Köhnə tək şəkli yeni çoxşəkilli formata keçir
update public.wa_contacts
set
  pending_image_paths = jsonb_build_array(pending_image_path),
  pending_image_mimes = jsonb_build_array(pending_image_mime)
where pending_image_path is not null
  and pending_image_mime is not null
  and pending_image_paths = '[]'::jsonb;

-- Əsas video işi
alter table public.generation_jobs
  add column if not exists video_mode text not null default 'single',
  add column if not exists target_duration_seconds integer not null default 10,
  add column if not exists scene_count integer not null default 1,
  add column if not exists stage text not null default 'queued',
  add column if not exists progress_completed integer not null default 0,
  add column if not exists progress_total integer not null default 1,
  add column if not exists source_image_paths jsonb not null default '[]'::jsonb,
  add column if not exists source_image_mimes jsonb not null default '[]'::jsonb,
  add column if not exists scene_plan jsonb,
  add column if not exists narration_text text,
  add column if not exists music_mood text,
  add column if not exists audio_storage_path text,
  add column if not exists error_code text;

alter table public.generation_jobs
  drop constraint if exists generation_jobs_prompt_check,
  drop constraint if exists generation_jobs_video_mode_check,
  drop constraint if exists generation_jobs_target_duration_seconds_check,
  drop constraint if exists generation_jobs_scene_count_check,
  drop constraint if exists generation_jobs_stage_check,
  drop constraint if exists generation_jobs_progress_check,
  drop constraint if exists generation_jobs_source_image_paths_check,
  drop constraint if exists generation_jobs_source_image_mimes_check;

alter table public.generation_jobs
  add constraint generation_jobs_prompt_check
    check (char_length(prompt) between 5 and 6000),
  add constraint generation_jobs_video_mode_check
    check (video_mode in ('single', 'long')),
  add constraint generation_jobs_target_duration_seconds_check
    check (target_duration_seconds in (5, 10, 60)),
  add constraint generation_jobs_scene_count_check
    check (scene_count between 1 and 6),
  add constraint generation_jobs_stage_check
    check (
      stage in (
        'queued',
        'planning',
        'generating_scenes',
        'composing',
        'narrating',
        'completed',
        'failed'
      )
    ),
  add constraint generation_jobs_progress_check
    check (
      progress_total >= 1
      and progress_completed >= 0
      and progress_completed <= progress_total
    ),
  add constraint generation_jobs_source_image_paths_check
    check (jsonb_typeof(source_image_paths) = 'array'),
  add constraint generation_jobs_source_image_mimes_check
    check (jsonb_typeof(source_image_mimes) = 'array');

-- Köhnə video işlərinin şəklini yeni formata keçir
update public.generation_jobs
set
  source_image_paths = jsonb_build_array(input_storage_path),
  source_image_mimes = jsonb_build_array(input_mime_type)
where source_image_paths = '[]'::jsonb;

-- Hər 10 saniyəlik Runway səhnəsi ayrıca saxlanılır
create table public.generation_segments (
  id uuid primary key default gen_random_uuid(),

  job_id uuid not null
    references public.generation_jobs(id)
    on delete cascade,

  scene_index integer not null
    check (scene_index between 1 and 6),

  status text not null default 'queued'
    check (
      status in (
        'queued',
        'processing',
        'completed',
        'failed'
      )
    ),

  prompt text not null
    check (char_length(prompt) between 5 and 2000),

  narration_text text,
  overlay_text text,
  transition text not null default 'fade',

  duration_seconds integer not null default 10
    check (duration_seconds between 3 and 10),

  input_storage_path text not null,
  input_mime_type text not null,

  output_storage_path text,
  provider_job_id text,

  attempts integer not null default 0
    check (attempts >= 0),

  error_code text,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (job_id, scene_index)
);

create index generation_segments_job_idx
  on public.generation_segments (job_id, scene_index);

create index generation_segments_queue_idx
  on public.generation_segments (created_at)
  where status = 'queued';

alter table public.generation_segments
  enable row level security;

revoke all
  on table public.generation_segments
  from anon, authenticated;

grant select, insert, update, delete
  on table public.generation_segments
  to service_role;

comment on table public.generation_segments is
  '1 dəqiqəlik reklamın ayrı-ayrı Runway səhnələri.';

comment on column public.generation_jobs.scene_plan is
  'AI tərəfindən yaradılan 6 səhnəlik reklam planı.';

commit;
