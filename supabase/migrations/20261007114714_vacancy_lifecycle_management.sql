begin;
alter table public.jobs add column scheduled_at timestamptz, add column approved_at timestamptz,
 add column delete_at timestamptz, add column revision integer not null default 1;
update public.jobs set created_at=coalesce(created_at,now()),delete_at=coalesce(created_at,now())+interval '28 days',
 expires_at=least(expires_at,coalesce(created_at,now())+interval '28 days'),
 approved_at=case when status='active' then coalesce(published_at,created_at,now()) else null end;
alter table public.jobs alter column delete_at set not null;
alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs add constraint jobs_status_check check(status in ('draft','pending','scheduled','active','paused','closed','rejected'));
alter table public.jobs add constraint jobs_schedule_before_delete check(scheduled_at is null or scheduled_at<delete_at);
create index jobs_delete_at_idx on public.jobs(delete_at);
create index jobs_scheduled_at_idx on public.jobs(scheduled_at) where status='scheduled';
create function public.guard_job_retention() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' then new.created_at:=old.created_at; end if;
 new.created_at:=coalesce(new.created_at,now());
 new.delete_at:=new.created_at+interval '28 days';
 new.expires_at:=least(new.expires_at,new.delete_at);
 return new;
end $$;
revoke all on function public.guard_job_retention() from public,anon,authenticated;
grant execute on function public.guard_job_retention() to service_role;
create trigger jobs_retention_guard before insert or update on public.jobs for each row execute function public.guard_job_retention();

create table public.job_media_cleanup(path text primary key,created_at timestamptz not null default now());
alter table public.job_media_cleanup enable row level security;
revoke all on public.job_media_cleanup from public,anon,authenticated;
grant select,insert,delete on public.job_media_cleanup to service_role;
create function public.delete_own_job_profile(p_profile uuid,p_wa_id text) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare photo text;
begin
 perform 1 from public.job_agent_profiles where id=p_profile and wa_id=p_wa_id and wa_id not like 'telegram-admin:%' for update;
 if not found then return false; end if;
 select photo_path into photo from public.employer_profiles where profile_id=p_profile;
 if photo is not null then insert into public.job_media_cleanup(path) values(photo) on conflict do nothing; end if;
 update public.jobs set status='closed',scheduled_at=null,approved_at=null,contact_phone=null,contact_email=null,
 metadata=(metadata-'employer_profile_id')||'{"owner_profile_deleted":true}'::jsonb,updated_at=now()
 where metadata->>'employer_profile_id'=p_profile::text;
 delete from public.job_agent_messages where profile_id=p_profile;
 delete from public.job_agent_profiles where id=p_profile;
 return true;
end $$;
revoke all on function public.delete_own_job_profile(uuid,text) from public,anon,authenticated;
grant execute on function public.delete_own_job_profile(uuid,text) to service_role;

create function public.save_vacancy_revision(p_job bigint,p_profile uuid,p_telegram_user text,p_revision integer,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.jobs; edited public.jobs; patch jsonb;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found or j.revision<>p_revision or j.delete_at<=now() then return null; end if;
 if p_profile is not null and p_telegram_user is null then
   if j.metadata->>'employer_profile_id' is distinct from p_profile::text then return null; end if;
   perform 1 from public.employer_profiles where profile_id=p_profile and registration_status='approved' and verified for share;
   if not found then return null; end if;
 elsif p_profile is null and p_telegram_user is not null then
   if j.metadata->>'telegram_admin_user_id' is distinct from p_telegram_user then return null; end if;
 else return null;
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into patch from jsonb_each(p_patch)
 where key=any(array['title','company_name','description','location_name','latitude','longitude','work_mode','salary_min','salary_max','contact_phone','contact_email','category_id','scheduled_at']);
 edited:=jsonb_populate_record(j,patch);
 if not (patch ? 'scheduled_at') and j.status='active' and edited.scheduled_at<=now() then edited.scheduled_at:=null; end if;
 if edited.title is null or length(trim(edited.title)) not between 1 and 120 or length(coalesce(edited.company_name,''))>160
 or length(coalesce(edited.description,''))>1500 or length(coalesce(edited.location_name,''))>250
 or (edited.work_mode in ('office','hybrid') and (edited.latitude is null or edited.longitude is null))
 or (edited.latitude is not null and edited.latitude not between -90 and 90)
 or (edited.longitude is not null and edited.longitude not between -180 and 180)
 or (edited.work_mode is not null and edited.work_mode not in ('office','remote','hybrid'))
 or coalesce(edited.salary_min,0)<0 or coalesce(edited.salary_max,0)<0
 or (edited.salary_min is not null and edited.salary_max is not null and edited.salary_max<edited.salary_min)
 or (edited.scheduled_at is not null and (edited.scheduled_at<=now() or edited.scheduled_at>=j.delete_at)) then raise exception 'Invalid vacancy edit' using errcode='22023'; end if;
 update public.jobs set title=edited.title,company_name=edited.company_name,description=edited.description,
 location_name=edited.location_name,latitude=edited.latitude,longitude=edited.longitude,work_mode=edited.work_mode,
 salary_min=edited.salary_min,salary_max=edited.salary_max,contact_phone=edited.contact_phone,contact_email=edited.contact_email,
 category_id=edited.category_id,scheduled_at=edited.scheduled_at,revision=j.revision+1,
 status=case when p_profile is not null then 'pending' when edited.scheduled_at>now() then 'scheduled' else 'active' end,
 approved_at=case when p_profile is null then now() else null end,
 published_at=case when p_profile is null and edited.scheduled_at is null then coalesce(j.published_at,now()) else null end,
 updated_at=now() where id=j.id returning * into edited;
 return to_jsonb(edited);
end $$;
revoke all on function public.save_vacancy_revision(bigint,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_vacancy_revision(bigint,uuid,text,integer,jsonb) to service_role;

create function public.run_vacancy_lifecycle() returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare removed integer; published integer;
begin
 if not pg_try_advisory_xact_lock(734982105) then return '{"busy":true}'::jsonb; end if;
 delete from public.jobs where delete_at<=now(); get diagnostics removed=row_count;
 update public.jobs j set status='active',published_at=now(),updated_at=now()
 where status='scheduled' and approved_at is not null and scheduled_at<=now() and delete_at>now() and expires_at>now()
 and (source<>'whatsapp' or coalesce(metadata->>'business_registration_version','')<>'1'
 or exists(select 1 from public.employer_profiles e where e.profile_id::text=j.metadata->>'employer_profile_id' and e.registration_status='approved' and e.verified));
 get diagnostics published=row_count;
 return jsonb_build_object('deleted',removed,'published',published);
end $$;
revoke all on function public.run_vacancy_lifecycle() from public,anon,authenticated;
grant execute on function public.run_vacancy_lifecycle() to service_role;
grant delete on public.jobs,public.job_agent_profiles,public.job_agent_messages to service_role;
alter table public.telegram_staff drop constraint if exists telegram_staff_permissions_check;
alter table public.telegram_staff add constraint telegram_staff_permissions_check check(permissions <@ array['approve','reject','create','edit','businesses','pending','statistics']::text[]);
alter table public.telegram_staff_invites drop constraint if exists telegram_staff_invites_permissions_check;
alter table public.telegram_staff_invites add constraint telegram_staff_invites_permissions_check check(permissions <@ array['approve','reject','create','edit','businesses','pending','statistics']::text[]);
-- Schedule is installed now but remains a no-op until this version starts.
create table public.vacancy_lifecycle_settings(id boolean primary key default true check(id),enabled boolean not null default false);
alter table public.vacancy_lifecycle_settings enable row level security;
revoke all on public.vacancy_lifecycle_settings from public,anon,authenticated;
grant select,update on public.vacancy_lifecycle_settings to service_role;
insert into public.vacancy_lifecycle_settings(id) values(true);
create function public.activate_vacancy_lifecycle() returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update public.vacancy_lifecycle_settings set enabled=true where id=true;
 return true;
end $$;
revoke all on function public.activate_vacancy_lifecycle() from public,anon,authenticated;
grant execute on function public.activate_vacancy_lifecycle() to service_role;
do $schedule$
begin
 if exists(select 1 from pg_available_extensions where name='pg_cron') then
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  perform cron.schedule('adyarat-vacancy-lifecycle','* * * * *',
   'select public.run_vacancy_lifecycle() from public.vacancy_lifecycle_settings where id=true and enabled;');
 end if;
end $schedule$;
notify pgrst,'reload schema';
commit;
