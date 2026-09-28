begin;

alter table public.wa_contacts
  drop constraint if exists wa_contacts_selected_video_duration_seconds_check;

alter table public.wa_contacts
  add constraint wa_contacts_selected_video_duration_seconds_check
    check (
      selected_video_duration_seconds in (
        10,
        20,
        30,
        40,
        50,
        60,
        70,
        80,
        90,
        100,
        110,
        120,
        130,
        140,
        150,
        160,
        170,
        180
      )
    );

alter table public.generation_jobs
  drop constraint if exists generation_jobs_target_duration_seconds_check,
  drop constraint if exists generation_jobs_scene_count_check;

alter table public.generation_jobs
  add constraint generation_jobs_target_duration_seconds_check
    check (
      target_duration_seconds in (
        10,
        20,
        30,
        40,
        50,
        60,
        70,
        80,
        90,
        100,
        110,
        120,
        130,
        140,
        150,
        160,
        170,
        180
      )
    ),
  add constraint generation_jobs_scene_count_check
    check (
      scene_count between 1 and 18
    );

alter table public.generation_segments
  drop constraint if exists generation_segments_scene_index_check;

alter table public.generation_segments
  add constraint generation_segments_scene_index_check
    check (
      scene_index between 1 and 18
    );

comment on table public.generation_segments is
  '10-180 saniyəlik reklamların ayrı-ayrı 10 saniyəlik video səhnələri.';

comment on column public.generation_jobs.scene_plan is
  'AI tərəfindən yaradılan dinamik sayda reklam səhnələrinin planı.';

commit;
