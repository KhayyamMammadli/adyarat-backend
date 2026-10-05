begin;
alter table public.employer_profiles
 add column if not exists voen_verification_method text,
 add column if not exists voen_verified_by text;
alter table public.employer_profiles add constraint employer_voen_method_check
 check(voen_verification_method is null or voen_verification_method in ('registry','pending_admin','admin_manual'));
-- Do not infer verification from old 10-digit VÖEN values or fabricate registry evidence.
-- Previously verified integration records preserve their source marker.
update public.employer_profiles set voen_verification_method='registry'
 where voen_verification_method is null and voen_verified_at is not null and registry_reference is not null;
alter table public.employer_profiles add constraint employer_manual_voen_evidence_check
 check(voen_verification_method <> 'admin_manual' or
 (voen_verified_by is not null and length(trim(voen_verified_by))>0 and voen_verified_at is not null
 and legal_name is not null and length(trim(legal_name))>0 and registry_reference is not null));
alter table public.employer_profiles add constraint employer_pending_voen_unverified_check
 check(voen_verification_method <> 'pending_admin' or
 (voen_verified_at is null and voen_verified_by is null and legal_name is null and registry_reference is null));
notify pgrst, 'reload schema';
commit;
