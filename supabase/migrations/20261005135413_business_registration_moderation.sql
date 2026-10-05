begin;
-- Profiles and approval evidence are server-only; the backend uses service_role.
-- No authenticated/public client profile API exists in this repository.
alter table public.job_agent_profiles enable row level security;
alter table public.employer_profiles enable row level security;
revoke all on public.job_agent_profiles,public.employer_profiles from public,anon,authenticated;
grant all on public.job_agent_profiles,public.employer_profiles to service_role;

-- Canonical profile contacts shared by seeker and employer roles.
alter table public.job_agent_profiles add column if not exists contact_email text;
alter table public.job_agent_profiles add column if not exists contact_phone text;
alter table public.employer_profiles
  add column if not exists business_type text,
  add column if not exists business_description text,
  add column if not exists business_address text,
  add column if not exists photo_path text,
  add column if not exists legal_name text,
  add column if not exists registry_reference text,
  add column if not exists voen_verified_at timestamptz,
  add column if not exists registration_status text not null default 'draft',
  add column if not exists registration_token text,
  add column if not exists rejection_reason text,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz;
alter table public.employer_profiles add constraint employer_registration_status_check
  check (registration_status in ('draft','pending','approved','rejected'));

create or replace function public.normalize_job_phone(raw text) returns text
language sql immutable strict security invoker set search_path = '' as $$
  with digits as (select regexp_replace(raw, '[^0-9]', '', 'g') v),
  international as (select case when v like '00%' then substring(v from 3)
    when v ~ '^0[0-9]{9}$' then '994' || substring(v from 2) else v end v from digits)
  select case when v ~ '^[1-9][0-9]{6,14}$' then '+' || v end from international;
$$;
revoke all on function public.normalize_job_phone(text) from public, anon, authenticated;
grant execute on function public.normalize_job_phone(text) to service_role;

-- Preserve legacy contacts. Existing duplicates abort this entire migration; never
-- choose a winner or delete users automatically. Audit/resolve duplicates before retrying.
update public.job_agent_profiles p set contact_email=lower(trim(e.email))
from public.employer_profiles e where e.profile_id=p.id and nullif(trim(e.email),'') is not null and p.contact_email is null;
create unique index job_profile_contact_email_unique on public.job_agent_profiles (lower(trim(contact_email))) where contact_email is not null;
create unique index job_profile_contact_phone_unique on public.job_agent_profiles (public.normalize_job_phone(contact_phone)) where contact_phone is not null;
-- Do not auto-fill contact_phone: WhatsApp transport identity is not permission to
-- publish or adopt it as the profile's declared contact number.

create or replace function public.claim_job_profile_contact(p_profile_id uuid, p_email text default null, p_phone text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare email_value text; phone_value text; changed_email boolean; changed_phone boolean;
begin
  email_value := case when p_email is null then null else lower(trim(p_email)) end;
  phone_value := public.normalize_job_phone(p_phone);
  if p_email is not null and (length(email_value)>254 or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Invalid email' using errcode='22023';
  end if;
  if p_phone is not null and phone_value is null then raise exception 'Invalid phone' using errcode='22023'; end if;
  if email_value is null and phone_value is null then raise exception 'Contact required' using errcode='22023'; end if;
  -- Locks serialize concurrent claims, including the legacy transport/email checks.
  if email_value is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('job-email:'||email_value,0)); end if;
  if phone_value is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('job-phone:'||phone_value,0)); end if;
  if exists(select 1 from public.job_agent_profiles p where p.id<>p_profile_id and
    ((email_value is not null and lower(trim(p.contact_email))=email_value) or
     (phone_value is not null and (public.normalize_job_phone(p.contact_phone)=phone_value or public.normalize_job_phone(p.phone)=phone_value))))
    or exists(select 1 from public.employer_profiles e where e.profile_id<>p_profile_id and email_value is not null and lower(trim(e.email))=email_value) then
    raise exception 'Contact already registered' using errcode='23505';
  end if;
  select email_value is not null and p.contact_email is distinct from email_value,
    phone_value is not null and p.contact_phone is distinct from phone_value into changed_email, changed_phone
    from public.job_agent_profiles p where p.id=p_profile_id for update;
  if not found then raise exception 'Profile not found' using errcode='P0002'; end if;
  update public.job_agent_profiles set contact_email=coalesce(email_value,contact_email),contact_phone=coalesce(phone_value,contact_phone) where id=p_profile_id;
  if changed_email or changed_phone then
    update public.employer_profiles set email=coalesce(email_value,email),
      registration_status=case when registration_status in ('approved','pending') then 'draft' else registration_status end,
      verified=false, registration_token=null where profile_id=p_profile_id;
  end if;
end;
$$;
revoke all on function public.claim_job_profile_contact(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_job_profile_contact(uuid,text,text) to service_role;

-- Enforce the registration gate atomically even if two webhook workers race
-- with a profile edit/revocation. Telegram and external sources keep their own flow.
create or replace function public.guard_whatsapp_business_job() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare e public.employer_profiles%rowtype;
begin
  if new.source <> 'whatsapp' then return new; end if;
  if tg_op='UPDATE' and (new.status<>'pending' or old.status=new.status) then return new; end if;
  select * into e from public.employer_profiles where profile_id=(new.metadata->>'employer_profile_id')::uuid for share;
  if not found or e.registration_status is distinct from 'approved' or e.verified is distinct from true or e.voen_verified_at is null
    or e.registry_reference is null or e.photo_path is null then
    raise exception 'Approved business profile required' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_whatsapp_business_job() from public,anon,authenticated;
grant execute on function public.guard_whatsapp_business_job() to service_role;
create trigger whatsapp_business_registration_gate before insert or update of status on public.jobs
for each row execute function public.guard_whatsapp_business_job();

do $$ begin
  if exists(select 1 from storage.buckets where id='job-business-photos' and public) then
    raise exception 'Business photo bucket must be private';
  end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('job-business-photos','job-business-photos',false,5242880,array['image/jpeg','image/png'])
on conflict(id) do nothing;
-- No public Storage policy. The existing server service key uploads/signs private photos.
notify pgrst, 'reload schema';
commit;
