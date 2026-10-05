# WhatsApp Job Agent

The live webhook is `GET/POST /webhooks/whatsapp`. Signature verification,
queue storage and the existing webhook worker are preserved. The worker routes
only to JobAgentWebhookService; interactive replies use IDs, never their labels.
Unsupported media shows the vacancy menu and does not invoke an advertising flow.

## Findings and changes

Previously: text-only 1/2 menu, welcome did not reset state, company name was
missing from the vacancy, seeker writes ignored errors, results stopped at five,
and entering a contact submitted immediately without preview or Telegram notice.

Now: an interactive list has seeker, employer, all vacancies, profile and matching
vacancies. Every question offers a main-menu button. Explicit role actions can
interrupt and restart an unfinished flow. Bare numbers are only answers to the
current step. Replies from incompatible older menus are rejected without writing
text into the current step. Starting a seeker flow clears its editable search
preferences; starting an employer flow clears the draft pointer. Abandoned drafts
remain private drafts; pending and active vacancies are never reset or edited.

Seeker: title → city → work mode → minimum salary → saved profile.
Employer: company → title → city/address → work mode → minimum/maximum salary →
description → contact → preview → explicit confirmation → pending moderation.
All checked writes propagate database errors before advancing the flow.
Draft updates require both draft status and the owning employer profile ID.

## Storage

Read-only inspection of the existing Khayyam project confirmed these tables:

| Table                  | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| job_agent_profiles     | WhatsApp identity, display name, role and current state |
| job_seeker_preferences | Desired title, location, work modes and minimum salary  |
| employer_profiles      | Company name and metadata.draft_job_id                  |
| jobs                   | Vacancy fields, status and metadata.employer_profile_id |

The existing state column is free text; existing job statuses support draft,
pending, active and rejected. No migration or production database write is required
for this change. The repository's historical migrations do not contain these Job
Agent tables: a new empty Supabase project would need their existing schema first.
No credentials or environment settings are changed.

## Browsing and moderation

All vacancies lists active, unexpired rows without seeker filters. Matching needs
a completed profile and filters title, city (except remote), work mode and salary.
Salary matches when maximum pay reaches the requested minimum, or minimum pay
reaches it if maximum is absent; undisclosed salaries are excluded from matches.
There are five vacancy rows per page, plus next/back/menu (maximum eight rows).
Results use created_at descending then ID descending; offset pagination can shift
if moderators add or remove vacancies while someone browses. Detail views recheck
active/expiry status and include description/contact plus a return button.

Existing authorized Telegram `/pending`, `/approve ID`, `/reject ID reason` commands
remain. Submission notifies the configured admin. Only `/approve` transitions a
pending vacancy to active and sets published_at. `/pending` sends separate bounded
messages for each vacancy. Telegram notification delivery uses the existing
best-effort transport; admins can still retrieve pending jobs with `/pending` if
a notification fails or Telegram settings are missing.

VideoModule is not loaded in the vacancy application's root module: historical
queued video jobs cannot send old advertising menus or results into this service.
Legacy video code remains available and its regression tests are still run.

## Verification and release boundary

`npm run typecheck` and `npm test` build and run the existing regression tests plus
Job Agent routing, persistence, validation, pagination, moderation, webhook and
interactive payload tests. The feature branch now runs the existing GitHub CI.
Tests use an isolated stateful Supabase query fixture and mocked outbound clients;
no real WhatsApp/Telegram message is sent. Production schema was inspected with
read-only SQL. Live end-to-end delivery needs a separately authorized test rollout.

Changes belong only to feat/job-agent-interactive-menu. No main merge, database
mutation, token rotation or production deployment is part of this change.
