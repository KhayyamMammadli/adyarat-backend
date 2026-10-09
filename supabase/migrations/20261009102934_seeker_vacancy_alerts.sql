begin;
create table public.job_alert_subscriptions (
 id bigint generated always as identity primary key,
 profile_id uuid not null references public.job_agent_profiles(id) on delete cascade,
 category_id bigint not null references public.job_categories(id),
 location_name text check(location_name is null or length(trim(location_name)) between 1 and 250),
 salary_min numeric not null default 0 check(salary_min between 0 and 1000000),
 work_modes text[] not null default '{}' check(work_modes <@ array['office','remote','hybrid']::text[]),
 revision integer not null default 1,
 consent_at timestamptz not null default now(),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table public.job_alert_subscriptions enable row level security;
revoke all on public.job_alert_subscriptions from public,anon,authenticated;
grant select,insert,update,delete on public.job_alert_subscriptions to service_role;
grant usage,select on sequence public.job_alert_subscriptions_id_seq to service_role;
create index job_alert_subscriptions_profile on public.job_alert_subscriptions(profile_id);
create function public.guard_alert_subscription() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from job_agent_profiles where id=new.profile_id for update;
 if tg_op='INSERT' and (select count(*) from job_alert_subscriptions where profile_id=new.profile_id)>=10 then raise exception 'Maximum 10 alerts'; end if;
 perform 1 from job_categories where id=new.category_id and is_active;
 if not found then raise exception 'Inactive category'; end if;
 if tg_op='UPDATE' then new.profile_id:=old.profile_id;new.created_at:=old.created_at;new.revision:=old.revision+1;end if;
 new.updated_at:=now(); return new;
end $$;
create trigger guard_alert_subscription before insert or update on public.job_alert_subscriptions for each row execute function public.guard_alert_subscription();
revoke all on function public.guard_alert_subscription() from public,anon,authenticated;
grant execute on function public.guard_alert_subscription() to service_role;
create function public.vacancy_matches_alert(j public.jobs,a public.job_alert_subscriptions) returns boolean
language sql stable security invoker set search_path=public,pg_temp as $$
select j.status='active' and (j.expires_at is null or j.expires_at>now()) and j.delete_at>now()
 and j.category_id=a.category_id
 and (cardinality(a.work_modes)=0 or j.work_mode=any(a.work_modes))
 and (a.location_name is null or j.work_mode='remote' or
 (lower(a.location_name) in ('bakı','baki','baku') and lower(j.location_name) similar to '%(bakı|baki|baku)%') or
 strpos(lower(j.location_name),lower(a.location_name))>0)
 and (a.salary_min=0 or (coalesce(j.salary_currency,'AZN')='AZN' and coalesce(j.salary_max,j.salary_min)>=a.salary_min));
$$;
create table public.job_alert_deliveries (
 id bigint generated always as identity primary key,
 profile_id uuid not null references public.job_agent_profiles(id) on delete cascade,
 job_id bigint not null references public.jobs(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','sending','sent','failed','cancelled','unknown')),
 attempts integer not null default 0,message_id text,last_error text,
 published_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(profile_id,job_id)
);
alter table public.job_alert_deliveries enable row level security;
revoke all on public.job_alert_deliveries from public,anon,authenticated;
grant select,insert,update,delete on public.job_alert_deliveries to service_role;
grant usage,select on sequence public.job_alert_deliveries_id_seq to service_role;
create index job_alert_deliveries_queue on public.job_alert_deliveries(status,updated_at);
create function public.queue_published_vacancy_alerts() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.status<>'active' or (tg_op='UPDATE' and old.status='active') then return new;end if;
 insert into job_alert_deliveries(profile_id,job_id)
 select distinct a.profile_id,new.id from job_alert_subscriptions a join job_agent_profiles p on p.id=a.profile_id
 where p.wa_id not like 'telegram-admin:%' and vacancy_matches_alert(new,a) on conflict(profile_id,job_id) do nothing;
 return new;
end $$;
create trigger queue_published_vacancy_alerts after insert or update of status on public.jobs for each row execute function public.queue_published_vacancy_alerts();
create function public.claim_job_alert_deliveries() returns setof public.job_alert_deliveries
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update job_alert_deliveries set status='unknown',last_error='Unconfirmed send after worker interruption',updated_at=now()
 where status='sending' and updated_at<now()-interval '10 minutes';
 update job_alert_deliveries d set status='cancelled',updated_at=now() where status in ('queued','failed') and
 not exists(select 1 from job_alert_subscriptions a join jobs j on j.id=d.job_id
 where a.profile_id=d.profile_id and a.created_at<=d.published_at and vacancy_matches_alert(j,a));
 return query with selected as (
 select id from job_alert_deliveries where status='queued' or (status='failed' and attempts<3 and updated_at<now()-interval '5 minutes')
 order by id for update skip locked limit 20
 ) update job_alert_deliveries d set status='sending',attempts=attempts+1,updated_at=now()
 from selected s where d.id=s.id returning d.*;
end $$;
create function public.job_alert_delivery_target(p_delivery bigint) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
select jsonb_build_object('wa_id',p.wa_id,'job',to_jsonb(j)) from job_alert_deliveries d
 join jobs j on j.id=d.job_id join job_agent_profiles p on p.id=d.profile_id
 where d.id=p_delivery and d.status='sending' and exists(
 select 1 from job_alert_subscriptions a where a.profile_id=d.profile_id and a.created_at<=d.published_at and vacancy_matches_alert(j,a));
$$;
revoke all on function public.vacancy_matches_alert(public.jobs,public.job_alert_subscriptions),public.queue_published_vacancy_alerts(),public.claim_job_alert_deliveries(),public.job_alert_delivery_target(bigint) from public,anon,authenticated;
grant execute on function public.vacancy_matches_alert(public.jobs,public.job_alert_subscriptions),public.queue_published_vacancy_alerts(),public.claim_job_alert_deliveries(),public.job_alert_delivery_target(bigint) to service_role;
notify pgrst,'reload schema';
commit;
