# Saved vacancy alerts

Seekers browse without completing a profile. **Bildirişlərim** creates up to ten saved criteria: an existing active category, minimum AZN salary, optional city and office/remote/hybrid mode. Users explicitly consent before saving and can edit or delete each choice. Categories are selected from the existing catalogue; seekers do not modify the shared catalogue.

## Activation

This branch does not enable production sends. Apply `supabase/migrations/20261009102934_seeker_vacancy_alerts.sql` to Khayyam's Supabase project only after review. No existing rows are removed and existing published jobs are not backfilled.

Create and obtain Meta approval for a WhatsApp template with six BODY text parameters in this exact order: position, company, salary, location, contact, job ID. Example body:

> Seçdiyiniz kriteriyalara uyğun yeni vakansiya:
> Vəzifə: {{1}}
> Şirkət: {{2}}
> Maaş: {{3}}
> Yer: {{4}}
> Əlaqə: {{5}}
> Ətraflı məlumat üçün “Elan {{6}}” yazın.
> Bildirişləri dayandırmaq üçün “Bildirişlərim” bölməsindən seçimlərinizi silin.

Use the actual approved template name and language code; Meta determines its category and approval. Configure Khayyam's Render service with `JOB_ALERT_TEMPLATE_NAME`, `JOB_ALERT_TEMPLATE_LANGUAGE`, then `JOB_ALERTS_ENABLED=true`. Keep sends disabled until migration and template are ready. Reuse existing WhatsApp credentials. No live users are messaged by tests.

## Delivery and matching

A database trigger queues newly active jobs from any publication path, including scheduled publication. Drafts and pending jobs do not send. Salary floors compare the maximum offered salary (or minimum when maximum is absent); missing or foreign-currency salaries do not satisfy a positive AZN floor. Remote jobs can match any city; explicit mode restrictions still apply. Baku spellings are normalized for matching.

The existing backend polls the durable queue every ten seconds while running. A sleeping service resumes when it wakes; this is not a guaranteed immediate-delivery service. The worker atomically claims batches using row locks and rechecks current criteria and vacancy availability immediately before sending. Deleting or changing criteria cancels pending messages that no longer match.

One recipient/job delivery is stored regardless of overlapping criteria or repeated approval. Explicit HTTP 4xx rejections get at most three attempts, with five-minute spacing. Timeout/5xx outcomes and interrupted sends become `unknown` instead of automatically resending and risking duplicates. `sent` means Meta accepted the request and returned a message ID, not proof that the recipient read or received it. Queue tables and functions are restricted to `service_role`; subscriptions are scoped to the authenticated WhatsApp sender by the backend.
