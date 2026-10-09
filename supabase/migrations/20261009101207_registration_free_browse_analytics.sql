begin;
create table public.vacancy_browse_events (
 id bigint generated always as identity primary key,
 profile_id uuid not null references public.job_agent_profiles(id) on delete cascade,
 kind text not null check (kind in ('list','detail')),
 job_id bigint,
 category_id bigint,
 created_at timestamptz not null default now()
);
alter table public.vacancy_browse_events enable row level security;
revoke all on public.vacancy_browse_events from public,anon,authenticated;
grant select,insert on public.vacancy_browse_events to service_role;
grant usage,select on sequence public.vacancy_browse_events_id_seq to service_role;
create index vacancy_browse_events_profile_time on public.vacancy_browse_events(profile_id,created_at);
create index vacancy_browse_events_time on public.vacancy_browse_events(created_at);
create function public.vacancy_browse_statistics(p_now timestamptz default now()) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
with bounds as (
 select (date_trunc('day',p_now at time zone 'Asia/Baku') at time zone 'Asia/Baku') as day_start,
 (date_trunc('week',p_now at time zone 'Asia/Baku') at time zone 'Asia/Baku') as week_start,
 (date_trunc('month',p_now at time zone 'Asia/Baku') at time zone 'Asia/Baku') as month_start
), events as (
 select e.* from vacancy_browse_events e join job_agent_profiles p on p.id=e.profile_id
 where p.role is distinct from 'employer' and p.wa_id not like 'telegram-admin:%' and e.created_at<=p_now
), summary as (
 select count(distinct profile_id) as visitors,
 count(distinct profile_id) filter(where created_at>=day_start) as active_day,
 count(distinct profile_id) filter(where created_at>=week_start) as active_week,
 count(distinct profile_id) filter(where created_at>=month_start) as active_month,
 count(*) filter(where kind='detail') as detail_views from events cross join bounds
), popular_jobs as (
 select e.job_id,j.title,count(*) as views from events e left join jobs j on j.id=e.job_id
 where e.kind='detail' group by e.job_id,j.title order by views desc,e.job_id limit 5
), popular_categories as (
 select e.category_id,c.name,count(*) as selections from events e left join job_categories c on c.id=e.category_id
 where e.kind='list' and e.category_id is not null group by e.category_id,c.name order by selections desc,e.category_id limit 5
)
select jsonb_build_object('visitors',visitors,'activeDay',active_day,'activeWeek',active_week,'activeMonth',active_month,'detailViews',detail_views,
 'topJobs',coalesce((select jsonb_agg(to_jsonb(j)) from popular_jobs j),'[]'::jsonb),
 'topCategories',coalesce((select jsonb_agg(to_jsonb(c)) from popular_categories c),'[]'::jsonb)) from summary;
$$;
revoke all on function public.vacancy_browse_statistics(timestamptz) from public,anon,authenticated;
grant execute on function public.vacancy_browse_statistics(timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
