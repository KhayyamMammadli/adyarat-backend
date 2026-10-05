# Vacancy aggregator MVP

## Real source status (research: 2026-10-05)

**No external source is enabled or imported into production in this release.**
This is a tested import pipeline plus permission-gated adapter preparation, not a
claim that Boss/HelloJob were successfully scraped. Neither adapter contacts the
site in its disabled state.

| Source                 | Research and transport                                                                                                                                                                                                                                       | MVP status                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boss.az                | Current AZ terms §8.3 prohibit automated access. Legacy search results mention RSS, but a currently supported/licensed feed or official public API could not be verified. Ordinary robots probe returned HTTP 403.                                           | Disabled. Prepared standard RSS/Atom parser; needs a publisher agreement and verified feed contract before implementation can enable it.             |
| HelloJob.az            | Public listing/rules pages are indexed. Direct home and robots HTTP probes returned 403 in this environment; the response does not establish whether the origin or infrastructure enforced it. No official API/feed or permission to republish was verified. | Disabled. Offline schema.org JobPosting parser only; current live HTML format is unverified. No CAPTCHA/login/contact-reveal or anti-bot workaround. |
| Authorized RSS partner | Generic RSS/Atom transport can be configured with an approved HTTPS endpoint, exact allowed hostname, source ID and recorded permission reference. No partner was supplied.                                                                                  | Unconfigured. Tested using synthetic fixtures only.                                                                                                  |

Research pages:

- https://boss.az/pages/terms-conditions
- https://www.hellojob.az/page/qaydalar
- https://www.hellojob.az/

Search-provider access is used only for research, never as a production scraping
proxy. Public visibility does not automatically grant republication permission.
The generic partner adapter rejects Boss/HelloJob and their subdomains, so it
cannot be used to circumvent their disabled adapters. There are no guessed API
endpoints, login credentials, proxy rotations, browser automation or bot bypasses.

## Existing system analysis

Base main commit: `5a66116b75f65bb1211a95bd4d4462cd3a58dca3`.
Read-only Supabase inspection: project `jsghasqmddbyauygfvno`, existing `jobs`,
`job_categories`, `job_agent_profiles`, `employer_profiles`, and
`job_seeker_preferences`. Jobs have a unique `(source, source_id)`, nullable
category FK, JSONB metadata and statuses draft/pending/active/paused/closed/rejected.
There is no independent approved flag. Approval means active + published_at.

WhatsApp `/webhooks/whatsapp` keeps signature verification, persistent webhook
queue and JobAgent worker. The interactive seeker/employer/profile/detail/menu
states are unchanged. Browsing uses all active, unexpired jobs without a source
filter, five rows/page and next/back/menu. `vacancy-query.ts` now holds shared
active/matching rules; the web application does not load the collector CLI.

Telegram `/telegram/webhook` retains chat/user/secret authorization, interactive
approve/reject/reason conversation and `/admin` direct active creation. Render
production service `srv-daqe1n7f3r2c73b10eeg` is a Docker web service on main,
free, one instance, health `/health`, auto-deploy main. The historical root
render.yaml says node; it is left untouched to avoid changing the live service.

## Pipeline and moderation

Adapter → bounded fetch/parse → deterministic normalization → optional semantic
provider → idempotent insert → Telegram pending preview → existing approval.
Only new pending jobs produce an admin preview. Notification failure is best
effort; `/pending` still retrieves persisted jobs. Existing `/pending` shows the
oldest ten jobs at a time; moderate those to advance through a larger backlog.
Closed/expired external records are stored closed and never shown or approved.
Manual WhatsApp employer moderation continues as before.

External records are pending by default even if the source publishes them as
active. This avoids treating an external site's status as our admin approval.
Collectors cannot overwrite an active/rejected/closed moderator decision. This
MVP is import-only: changed upstream descriptions are not refreshed on conflict,
and missing feed entries do not silently close jobs. Explicit source expiry is
used; without one a conservative 30-day TTL is measured from source publication,
or collection time if publication is unknown. Future refresh/closure policies
must preserve moderation and should be reviewed independently.

Normalized fields map to the **same jobs table**:

| Normalized field                               | Storage                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| source / external_id / source_url              | jobs.source / source_id / source_url                                                              |
| title / company / city/location                | title / company_name / location_name                                                              |
| category                                       | existing active category name mapped to category_id when found; metadata.category always retained |
| work_mode / salary_min / salary_max / currency | work_mode / salary_min / salary_max / salary_currency                                             |
| description / requirements / skills            | description / metadata.requirements / metadata.skills                                             |
| published_at / collected_at                    | metadata.source_published_at / metadata.collected_at                                              |
| moderation publication / expiry / status       | jobs.published_at set by admin / expires_at / status                                              |
| future cross-source dedup hint                 | metadata.fingerprint (title/company/location SHA-256)                                             |

Source+external ID is unique; when ID is missing, canonical source URL is hashed.
Tracking query params/hash/trailing slash are removed, semantic query values are
preserved. A unique source+canonical URL index also catches changing external IDs.
Cross-source fingerprints are recorded but do not automatically suppress jobs:
different legitimate roles can share a title/company/location.

Plain salary ranges and work-mode/skill keywords use deterministic parsing.
Hourly/yearly pay is not compared with monthly seeker salaries. Missing pay stays
null; missing work mode stays null (FULL_TIME is not evidence of office work).
An optional `SemanticNormalizationProvider` may enrich category, skills, work mode
and requirements only when missing. No AI provider/API is enabled or invoked by
CLI. Errors/timeouts fall back to deterministic fields; providers cannot approve
jobs or change identity/pay. Outbound AI would require an explicit provider
implementation and content/privacy review before activation.

## Migration and release boundary

`supabase/migrations/20261005115222_vacancy_aggregator.sql` adds:

1. Nullable `jobs.source_url` and unique partial `(source, source_url)` index.
2. `vacancy_notification_intents` with unique `(profile_id, job_id)`, FKs, disabled
   default, RLS enabled, anon/authenticated access revoked and service-role access.

This is **not a second vacancy table**. Existing jobs/profiles are not deleted or
relabelled. Migration was generated with Supabase CLI and is committed only;
**it has not been applied to production**. Apply the additive migration before
rolling out this code, since pending moderation queries include source_url.
The repository's old migrations do not recreate externally provisioned Job Agent
schema; a clean database needs those existing tables first.

## Matching and future notifications

All approved jobs, independent of source, use persisted seeker title/category,
city (Bakı/Baki/Baku aliases; location ignored only for a remote vacancy), allowed
work modes, monthly minimum pay and currency. Undisclosed salaries cannot satisfy
a stated minimum. Optional `job_seeker_preferences.metadata.skills` is an array
of requested search skills; all specified skills must exist in the job's
normalized lower-case metadata.skills. Without skills, previous behavior remains.
The current seeker conversation does not add a CV/skill question in this change.

WhatsApp detail includes source and the canonical original link plus requirements.
Normal WhatsApp interactive pagination/detail/menu controls remain.

`DisabledNotificationPlanner.planMatches(jobId)` scans opt-in persisted profiles
in batches and uses the same matching query. `plan(profileId, jobId)` rechecks
opt-in, complete criteria, active/unexpired status and matching, then creates a
unique disabled intent. Repeated calls/restarts do not duplicate it. It has no
WhatsApp client, runs only when explicitly invoked, and is not automatically
called by collector or moderator. No real user notification is sent. A future
sender must additionally enforce WhatsApp consent/template/session policies and
an atomic delivery-state/outbox design before using these intents.

## Schedule / configuration

Build: `npm ci && npm run build`. Run once: `npm run collector`.
The CLI exits; it does not bootstrap Nest AppModule, webhooks or video workers.
With default configuration it reports both sources disabled and does no DB/network
writes. With an RSS URL configured, `COLLECTOR_ENABLED=true` is required for writes.

Optional `deployment/render-collector.yaml` is a **separate, undeployed** Blueprint
for a cron at `0 */6 * * *` UTC (every six hours; Baku 04:00/10:00/16:00/22:00).
It keeps collection disabled by default. The template was validated against
https://render.com/schema/render.yaml.json. No Render resource was created.
When an approved feed is available, configure only that cron with:

- COLLECTOR_ENABLED=true
- COLLECTOR_RSS_SOURCE (stable lower-case source identifier)
- COLLECTOR_RSS_URL / COLLECTOR_RSS_HOST (approved public HTTPS feed / exact host)
- COLLECTOR_RSS_PERMISSION (agreement/license reference; operator must verify it)
- existing SUPABASE_URL and server secret/service-role key via secret settings
- existing TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID if admin notices are wanted

No secret value is committed. The permission reference records an operator's
review; it is not automatic legal validation. Do not populate it without rights
to collect and republish that feed. Scheduled interval can change after agreement.

Fetches have no redirects/authentication, host/public-IP checks, 1 MB limit, 30s
source timeout, at most one delayed transient retry and no retry for 401/403.
Each source processes at most 50 items/run. DB requests time out after 15s;
semantic provider after 3s. One source/item failure does not stop the others.
Reports include inserted/duplicate/invalid counts; source errors yield a failed
cron exit code after healthy sources finish. Invalid records are logged/skipped
without sensitive payloads. Logs do not include API keys, tokens or arbitrary
response bodies. Cron single-run scheduling plus DB uniqueness guard overlap.

## Validation

Tests use synthetic RSS/Atom/JSON-LD fixtures and a stateful isolated Supabase
query fixture: parsing, normalization/AI fallback, identity/canonical duplicates,
moderation decision preservation, category/skills mapping, source isolation and
timeout, shared WhatsApp all/matching/detail/pagination, opt-in notification
intent deduplication/restart and disabled CLI. Existing seeker, employer,
Telegram authorization/creation/rejection and historical regression tests run.
Typecheck/build/89 tests pass; default CLI reports disabled and exits. Production
schema inspection is read-only; no live collector import or outbound message test
was performed. Production dependencies audit reports zero vulnerabilities.
