begin;

alter table public.wa_contacts
  drop constraint if exists wa_contacts_state_check;

alter table public.wa_contacts
  add constraint wa_contacts_state_check
  check (
    state in (
      'new',
      'awaiting_prompt',
      'awaiting_ad_copy_brief',
      'awaiting_voice_ad_brief',
      'awaiting_support_message',
      'processing'
    )
  );

commit;
