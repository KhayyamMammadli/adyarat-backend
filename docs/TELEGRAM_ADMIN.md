# Telegram vacancy administration

## Existing production system

Read-only inspection confirmed production main commit
`51e3e1d6889eee0af2da821efcb739a545885970`, a healthy Render service,
Supabase persistence and the existing Job Agent tables. The WhatsApp webhook,
worker, seeker/employer states, matching filters and pagination remain in place.
The Telegram webhook remains `/telegram/webhook`; legacy diagnostics and
`/pending`, `/approve ID`, `/reject ID reason` are retained.

## Flows

WhatsApp employer confirmation creates a pending row in `jobs` and sends a
bounded Telegram preview with ✅ Təsdiq et / ❌ Rədd et inline buttons.
Approval updates only a pending row to `active`, sets `published_at` and notifies
the employer. WhatsApp queries this same table without a source filter.
Rejection asks for a 1–500 character reason before changing the job. The reason
is stored in existing `jobs.metadata.moderation_reason` and sent to the owning
WhatsApp employer. Cancellation leaves the job pending. Stale moderation actions
cannot change an already moderated job.

`/admin` opens a button panel with Add vacancy and Pending vacancies. Creation
collects company, title, description, city/address, work mode, salary or range
(AZN; negotiable also supported), and phone/email contact. A final preview requires
an explicit publish button. Publishing inserts directly into the same `jobs`
table with `source=telegram_admin`, `status=active`, and `published_at`. It needs
no second moderation. Existing all-vacancies, matching, detail and pagination
handle these jobs; email contact is included in detail views. Optional category,
coordinates and expiry fields do not need invented values.

## State and authorization

No migration is needed. Restart-safe create/reject sessions are stored in
`employer_profiles.metadata.telegram_admin_session`, linked to isolated
`job_agent_profiles.wa_id=telegram-admin:<chat>:<user>` identities. Drafts expire
after one hour. Update IDs and session-specific buttons prevent duplicate step
advancement and stale publication; the existing unique `(source, source_id)`
constraint makes creation publication retry-safe. Optimistic state writes and a
per-user queue protect concurrent updates. These synthetic profiles never become
WhatsApp notification recipients.

The existing webhook secret is validated; production fails closed if it is not
configured. Both the configured admin chat and actual sending user must match.
Private chats default to their owner ID. Optional `TELEGRAM_ADMIN_USER_IDS` is a
comma-separated user-ID allowlist; group chats require it. In groups, free-text
answers must reply to that admin user's current question. No credentials or
production environment variables were changed.

Telegram submission notifications remain best effort; `/pending` retrieves jobs
if delivery failed. Employer notification errors are logged after moderation is
committed and do not revert the job. Delivery retries/outbox are not introduced.

## Verification

Typecheck, Nest build and all regression tests run locally. Tests use isolated
Supabase fixtures and mocked Telegram/WhatsApp clients, including button payloads,
authorization, reason persistence/restart, direct creation/retry, and shared
WhatsApp browsing/matching. No real outbound message or production database write
is performed. Changes are on `feat/telegram-admin-interactive`; no main merge or
production deployment is part of this work.
