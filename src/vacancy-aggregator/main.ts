import 'reflect-metadata';
import { createClient } from '@supabase/supabase-js';
import { configuredAdapters } from './adapters';
import { VacancyCollector } from './collector';
import { VacancyNormalizer } from './normalization';
import { CollectorRepository } from './repository';
import { ConfigService } from '@nestjs/config';
import { TelegramAdminService } from '../telegram/telegram.service';
import { moderationButtons, formatTelegramJob } from '../telegram/job-message';

export async function runCollector(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sources = configuredAdapters(env);
  // No web AppModule: no HTTP listener or WhatsApp/video polling workers in cron.
  if (!sources.some((s) => s.enabled)) {
    console.log(
      JSON.stringify(
        sources.map((s) => ({ source: s.source, status: 'disabled', reason: s.disabledReason })),
      ),
    );
    return;
  }
  if (env.COLLECTOR_ENABLED !== 'true') throw new Error('Collector writes are disabled');
  const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error('Collector Supabase configuration missing');
  const client = createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    },
  });
  const telegram = new TelegramAdminService(new ConfigService(env));
  const reports = await new VacancyCollector(
    sources,
    new VacancyNormalizer(),
    new CollectorRepository(client),
    30000,
    async (id, job) =>
      telegram.sendMessage(
        formatTelegramJob({
          ...job,
          id,
          company_name: job.company,
          location_name: job.location,
          salary_currency: job.currency,
        }),
        moderationButtons(id),
      ),
  ).run();
  console.log(JSON.stringify(reports));
  if (reports.some((r) => r.status === 'failed' || r.status === 'partial')) process.exitCode = 1;
}
if (require.main === module)
  void runCollector().catch(() => {
    console.error('Collector failed; check configuration and source reports');
    process.exitCode = 1;
  });
