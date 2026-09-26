begin;

alter table if exists public.wa_contacts
  add column if not exists free_video_used boolean not null default false;

update public.wa_contacts as contact
set free_video_used = true
where exists (
  select 1
  from public.generation_jobs as job
  where job.contact_id = contact.id
    and job.status = 'completed'
);

comment on column public.wa_contacts.free_video_used is
  'True after the contact receives the single free pilot video.';

commit;
