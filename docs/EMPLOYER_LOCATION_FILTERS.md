# Employer identity, vacancy maps and WhatsApp filters

Branch: `feat/employer-location-vacancy-filters`.
Base: main `a61710de81f7bf1bcf6e35e44838dcbfbb3d26ac` (same tree as the previously reviewed aggregator branch).

## Analysis before implementation

Read-only inspection of connected Supabase project `jsghasqmddbyauygfvno`:

- `jobs` already has nullable latitude, longitude, location_name, contact_email,
  contact_phone and category_id. `status=active` is approval/publication; there
  is no separate approval flag. Draft/pending/active/paused/closed/rejected statuses
  and `(source,source_id)` uniqueness are preserved.
- `job_seeker_preferences` already has latitude, longitude and radius_km alongside
  desired_title/category, city, modes and minimum monthly salary/currency.
- `employer_profiles` had no VÖEN/email columns. Its JSON metadata holds the
  employer draft pointer and namespaced Telegram admin session.
- `job_agent_profiles.state` is unrestricted text; role permits seeker/employer.
  New filter states are compatible with these actual constraints.
- Existing WhatsApp webhook handled text/interactive messages but not location.
  Existing employer required phone; Telegram creation requested only a text address.
  Shared active/matching queries were source independent and did not use radius.
- Existing Render main auto-deployment and collector configuration are unchanged.
  No deployment, DB mutation or real outbound message was performed for this work.

## Migration

`supabase/migrations/20261005123525_employer_location_filters.sql` is additive:

| Object             | Change                                                               |
| ------------------ | -------------------------------------------------------------------- |
| employer_profiles  | nullable `voen text`, `email text`                                   |
| job_agent_profiles | `browse_filters jsonb NOT NULL DEFAULT '{}'`                         |
| jobs_within_radius | SQL function returning canonical `jobs` rows with Haversine distance |

No new tables; no jobs/profiles are removed, relabelled, or backfilled with invented
locations/credentials. Coordinates reuse the existing jobs fields. Address is
stored in location_name, from native location/venue when supplied, otherwise from
previously entered city/address. No reverse geocoding or external map API key.

The radius function uses SECURITY INVOKER, empty search_path, restricted execution
(service_role only), input bounds and active/unexpired checks. Its output receives
normal PostgREST title/category/city/work-mode/salary/skills filters and stable
ordering BEFORE range/pagination. Old jobs without GPS remain in ordinary lists;
they cannot satisfy an explicit radius filter. A new global NOT NULL constraint
would invalidate old records and collector records, so human-flow requirements
are enforced at creation/submission boundaries instead.

Migration is committed **but not applied to production**. Apply it to a staging
DB before testing this branch. Before any later release ensure earlier aggregator
migration `20261005115222_vacancy_aggregator.sql` is also present. The historical
repo migrations do not recreate externally provisioned Job Agent base tables;
use a staging copy with the existing canonical schema.

## WhatsApp employer flow

Company → missing VÖEN → missing email → title → city/address → work mode →
(office/hybrid: native location) → minimum salary → maximum salary → description →
optional public phone choice → preview → Telegram moderation.

- VÖEN: exactly ten ASCII digits; all-zero value, blank, letters and wrong length
  rejected. Stored as text to preserve leading zeros. This is syntactic validation,
  not a tax-registry verification or a guessed checksum algorithm. verified flag
  is not changed. Reference: https://www.taxes.gov.az/az/post/370.
- Email is collected when missing, syntactically validated and stored in employer
  profile, then copied to vacancy contact_email. Prompt explicitly states it is
  visible to applicants. Legacy profiles complete missing credentials before
  creating or submitting a new vacancy. Completed legacy drafts resume confirmation
  after collecting missing credentials/GPS without creating another draft.
- Office/hybrid require numeric, finite latitude [-90,90] and longitude [-180,180].
  User shares the workplace pin using WhatsApp attachment → Location; text does
  not substitute for GPS. Remote proceeds directly to salary.
- Phone has `📱 Nömrə əlavə et` / `⏭️ Keç`. Skip stores null. Optional phone accepts
  7–15 digits with supported separators, never substitutes sender's WhatsApp ID.
- Final submission rechecks VÖEN/email/GPS so resumed older states cannot bypass
  new requirements. Manual employer jobs remain pending until Telegram approval.

## Browsing and matching

`📋 Bütün vakansiyalar` shows five active, unexpired jobs per page from every source.
Its list includes Filter / Clear / Next / Back / Main, at most ten total rows.
Filter menu provides title or active category, city/address, minimum monthly AZN
salary, office/remote/hybrid, and a native search-center location with 5/10/25/50/100
km radius. Categories have their own pagination. Selection/controls are interactive;
custom title/city/salary values still need text input. Title and category are
alternatives; selecting one clears the other. Other criteria combine with AND.
Bakı/Baki/Baku aliases are accepted. Maximum salary (or min when max unknown) must
meet the threshold; undisclosed pay cannot satisfy an explicit minimum.

Filters persist in job_agent_profiles.browse_filters across process restarts and
all-list page navigation. They do not overwrite seeker preferences or employer/
Telegram metadata. Apply/Clear starts at page one. Main/profile/role selection
clears temporary filters and cancels active state. Stale controls/locations cannot
become answers to another role. Restarting seeker setup clears old category/GPS/
radius criteria as well as title/city/salary/modes.

`🎯 Mənə uyğun vakansiyalar` uses the existing persisted profile/shared matching
query; when stored coordinates and valid radius exist, GPS filtering now applies.
Remote jobs bypass city/radius only in matching, while selected work modes still
apply. A deliberate radius filter in All is geographic and does not include remote
jobs without coordinates. This release does not add a seeker GPS onboarding step;
the existing preference fields are ready for a subsequent profile UI extension.
The disabled future notification planner inherits the same shared matching query.

Cards/preview/detail include available address and complete Google Maps link.
Office/hybrid detail also sends a native WhatsApp location message. If Meta cannot
send it, text already contains the map link and navigation remains available.
No coordinates means no fabricated map; old records remain usable.
Meta reference: https://www.postman.com/meta/whatsapp-business-platform/request/3pwqfn8/send-location-message.

## Telegram admin

Existing authorization/chat/user allowlist/secret, callback nonce, per-actor session,
replay handling, rejection reason and employer notifications remain in place.
Admin create: company → title → description → city/address → mode → office/hybrid
Location → salary → contact → confirmation. Remote skips Location. Share location
or venue with Telegram attachment → Location. Venue address updates location_name;
plain location keeps typed address. Group messages must Reply to the actor's current
question. Unauthorized location cannot change session. Office/hybrid service-level
creation also rejects missing GPS, including resumed old confirmation states.
Admin publication continues directly to active in the same jobs table.

## Verification and staging acceptance

- `npm run typecheck` passed; `npm test` includes Nest build and all 114 regression/new tests (114 passed, zero failures).
- New tests cover mandatory credentials, invalid email/GPS, office/hybrid/remote,
  phone add/skip, Supabase persistence, old drafts/old jobs, native location payload
  and fallback, webhook routing, filter/category pagination, radius query serialization,
  restart/user isolation, DB failures, Telegram auth/group Reply and stale states.
- Migration additionally executed in an isolated PGlite PostgreSQL instance against
  minimal schema/legacy fixtures: radius/remote/expiry/status/bounds, unchanged old
  rows, nullable profile fields, invoker security and function grants verified.
- No production WhatsApp end-to-end test is claimed: use separate test bot/number
  and staging DB. Create office and remote jobs, approve manual WhatsApp vacancy,
  create Telegram office vacancy, browse/filter/next/back, then open map detail.
- No new secrets/environment variables/dependencies are required by this feature.
  No secret was changed or committed; no production deploy/merge occurred.
