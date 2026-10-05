-- Additive migration. Existing manual jobs remain unchanged (source_url defaults NULL).
-- Existing Job Agent tables were provisioned outside this repository's historical migrations.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_url text;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_canonical_url_key
  ON public.jobs (source, source_url) WHERE source_url IS NOT NULL;

-- Persistent disabled notification intents, not a separate vacancy store.
CREATE TABLE IF NOT EXISTS public.vacancy_notification_intents (
  profile_id uuid NOT NULL REFERENCES public.job_agent_profiles(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'sent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, job_id)
);
ALTER TABLE public.vacancy_notification_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vacancy_notification_intents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vacancy_notification_intents TO service_role;
