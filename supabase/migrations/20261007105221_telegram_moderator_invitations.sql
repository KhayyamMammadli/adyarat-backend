create table public.telegram_staff_invites (
  id uuid primary key,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by text not null,
  creator_chat_id text not null,
  permissions text[] not null check (permissions <@ array['approve','reject','create','businesses','pending','statistics']::text[]),
  status text not null default 'created' check (status in ('created','claimed','approved','rejected','revoked')),
  candidate_id text,
  candidate_name text,
  candidate_username text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz
);
alter table public.telegram_staff_invites enable row level security;
revoke all on public.telegram_staff_invites from public, anon, authenticated;
grant select, insert, update on public.telegram_staff_invites to service_role;

-- Row locks make first-claim and approval atomic across multiple Render instances.
-- Invoker functions are callable only by the server's service role.
create function public.claim_telegram_staff_invite(p_hash text,p_user_id text,p_name text,p_username text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.telegram_staff_invites; fresh boolean := false;
begin
  if p_user_id !~ '^[1-9][0-9]{0,15}$' then return null; end if;
  select * into i from public.telegram_staff_invites where token_hash=p_hash for update;
  if not found or i.expires_at <= now() or i.status not in ('created','claimed') then return null; end if;
  if exists(select 1 from public.telegram_staff where user_id=p_user_id) then return null; end if;
  if i.status='created' then
    update public.telegram_staff_invites set status='claimed',candidate_id=p_user_id,
      candidate_name=left(p_name,200),candidate_username=left(p_username,64)
      where id=i.id returning * into i;
    fresh := true;
  elsif i.candidate_id is distinct from p_user_id then return null;
  end if;
  return to_jsonb(i) - 'token_hash' || jsonb_build_object('fresh_claim',fresh);
end $$;
revoke all on function public.claim_telegram_staff_invite(text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_telegram_staff_invite(text,text,text,text) to service_role;

create function public.finish_telegram_staff_invite(p_id uuid,p_actor text,p_owner text,p_decision text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.telegram_staff_invites; inserted integer;
begin
  if p_decision not in ('approve','reject','revoke') then return null; end if;
  if p_actor is distinct from p_owner and not exists(select 1 from public.telegram_staff where user_id=p_actor and role='admin' and active) then return null; end if;
  select * into i from public.telegram_staff_invites where id=p_id for update;
  if not found or i.expires_at <= now() or i.status not in ('created','claimed') then return null; end if;
  if p_decision='approve' then
    if i.status <> 'claimed' or i.candidate_id is null or i.candidate_id=p_owner then return null; end if;
    if i.created_by is distinct from p_owner and not exists(select 1 from public.telegram_staff where user_id=i.created_by and role='admin' and active) then return null; end if;
    insert into public.telegram_staff(user_id,role,permissions,updated_by)
      values(i.candidate_id,'moderator',i.permissions,p_actor) on conflict(user_id) do nothing;
    get diagnostics inserted = row_count;
    if inserted <> 1 then return null; end if;
  elsif p_decision='reject' and i.status <> 'claimed' then return null;
  end if;
  update public.telegram_staff_invites set status=case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'revoked' end,
    reviewed_by=p_actor,reviewed_at=now() where id=p_id returning * into i;
  return to_jsonb(i) - 'token_hash';
end $$;
revoke all on function public.finish_telegram_staff_invite(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_telegram_staff_invite(uuid,text,text,text) to service_role;
