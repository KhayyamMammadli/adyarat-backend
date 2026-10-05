# Vacancy visibility investigation (2026-10-05)

Inspected Khayyam Supabase project jsghasqmddbyauygfvno read-only. Public jobs is
the vacancy source of truth; there is no separate vacancy table. Its status is
draft/pending/active/paused/closed/rejected; approval means status=active and a
published_at timestamp, not a separate approved boolean.

Real rows: #1 is an incomplete draft. #2 is Frontend developer, Software MMC,
active, published 2026-10-05 10:48:12.993 UTC, no expiry, Baki, office,
2000–3500 AZN. Its employer profile is labelled Khayyam, not Asim Hesenov.
No Asim Hesenov/Hasanov identity or job is present among the two rows or their
owner/company data in this project. Do not relabel #2 or import from another
account/project based on an assumed identity.

The saved seeker desired_title, category_id, location_name and salary_min are
null, with empty work_modes. Matching correctly cannot run with this incomplete
profile. Choosing the seeker role resets editable criteria before asking its
questions, so leaving that flow early leaves incomplete criteria. No production
profile or job was changed during investigation.

The active/unexpired SQL query returns #2. The job:all webhook at 11:26:36 UTC
completed on first attempt; subsequent Meta delivery statuses were sent/read.
No database query or outbound error is recorded for that event. This evidence
cannot prove what appeared on the user's phone, or identify an absent Asim job.
Previously rows existed only inside WhatsApp's list picker; now current-page
previews are sent in chat too, preserving the picker/detail/pagination controls.

Confirmed matching defects: literal Bakı did not match DB Baki; category_id was
ignored; selecting remote together with office bypassed city filtering for office
jobs too. Fixes add city aliases, category/title alternatives, a per-vacancy
remote exception and matching salary currency. Existing expiry/status filters,
pagination and moderation ownership remain. User input inside OR expressions is
quoted and LIKE wildcards escaped. Arbitrary job sources still share one query.

Verification: real read-only SQL with the corrected title/location/mode/salary
criteria returns #2 for Frontend, Bakı, office, minimum 1000 AZN. Existing empty
production criteria still require profile completion. Isolated regression tests
cover the production-shaped #2, an explicitly synthetic Asim active fixture,
category-only search, expiry/pending exclusions, mixed work modes, currency,
next/back previews, and real Supabase SDK query serialization. No real message
was sent, no credentials changed, no main merge or deployment performed.
