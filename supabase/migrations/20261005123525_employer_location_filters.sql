-- Additive, legacy nullable fields: do not invalidate unfinished/historical profiles.
alter table public.employer_profiles add column if not exists voen text;
alter table public.employer_profiles add column if not exists email text;
alter table public.job_agent_profiles add column if not exists browse_filters jsonb not null default '{}'::jsonb;
-- Existing jobs.latitude/longitude and location_name remain the canonical location.
-- No backfill or destructive data change. New human-created office/hybrid jobs
-- are validated at service boundaries; historical and external records may lack GPS.
create or replace function public.jobs_within_radius(
  center_lat double precision, center_lon double precision, max_km double precision,
  include_remote boolean default false
) returns setof public.jobs language sql stable security invoker set search_path = '' as $$
  select j.* from public.jobs j
  where center_lat between -90 and 90 and center_lon between -180 and 180
    and max_km > 0 and max_km <= 200
    and j.status = 'active' and (j.expires_at is null or j.expires_at > now())
    and ((include_remote and j.work_mode = 'remote') or (
      j.latitude between -90 and 90 and j.longitude between -180 and 180
      and 6371 * 2 * asin(sqrt(least(1.0,
        power(sin(radians(j.latitude - center_lat)/2),2) +
        cos(radians(center_lat))*cos(radians(j.latitude))*
        power(sin(radians(j.longitude - center_lon)/2),2)))) <= max_km
    ));
$$;
revoke all on function public.jobs_within_radius(double precision,double precision,double precision,boolean) from public, anon, authenticated;
grant execute on function public.jobs_within_radius(double precision,double precision,double precision,boolean) to service_role;

-- Job Agent has no public Supabase client: all app access uses the server secret.
-- Protect identity, phone/GPS, preferences, Telegram sessions and moderation drafts.
alter table public.employer_profiles enable row level security;
alter table public.job_agent_profiles enable row level security;
alter table public.job_seeker_preferences enable row level security;
alter table public.jobs enable row level security;
revoke all on public.employer_profiles, public.job_agent_profiles,
  public.job_seeker_preferences, public.jobs from anon, authenticated;
grant select, insert, update on public.employer_profiles, public.job_agent_profiles,
  public.job_seeker_preferences, public.jobs to service_role;
