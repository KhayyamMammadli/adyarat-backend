import { SupabaseClient } from '@supabase/supabase-js';
import { NormalizedVacancy, VacancyNotificationPlanner } from './types';
import { completePreference, matchingVacancies } from '../job-agent/vacancy-query';

export class CollectorRepository {
  constructor(private readonly client: SupabaseClient) {}
  async insert(job: NormalizedVacancy): Promise<{ id: number; inserted: boolean }> {
    let categoryId: number | null = null;
    if (job.category) {
      const category = await this.client
        .from('job_categories')
        .select('id')
        .eq('is_active', true)
        .ilike('name', job.category.replace(/[\\%_]/g, '\\$&'))
        .limit(1)
        .maybeSingle();
      if (category.error) throw category.error;
      categoryId = category.data?.id ?? null;
    }
    const row = {
      source: job.source,
      source_id: job.external_id,
      source_url: job.source_url,
      title: job.title,
      company_name: job.company,
      category_id: categoryId,
      location_name: job.location,
      work_mode: job.work_mode,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      salary_currency: job.currency,
      description: job.description,
      expires_at: job.expires_at,
      status: job.status,
      // published_at is set by the existing moderator. Source publication has its own metadata.
      metadata: {
        collector: true,
        source_published_at: job.published_at,
        collected_at: job.collected_at,
        category: job.category,
        requirements: job.requirements,
        skills: job.skills,
        fingerprint: job.fingerprint,
      },
    };
    // Ignore conflicts instead of resetting a moderator's active/rejected decision on every run.
    const result = await this.client
      .from('jobs')
      .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();
    if (result.error && result.error.code !== '23505') throw result.error;
    if (result.data) return { id: result.data.id, inserted: true };
    const byId = await this.client
      .from('jobs')
      .select('id')
      .eq('source', job.source)
      .eq('source_id', job.external_id)
      .maybeSingle();
    if (byId.error) throw byId.error;
    if (byId.data) return { id: byId.data.id, inserted: false };
    const byUrl = await this.client
      .from('jobs')
      .select('id')
      .eq('source', job.source)
      .eq('source_url', job.source_url)
      .single();
    if (byUrl.error) throw byUrl.error;
    return { id: byUrl.data.id, inserted: false };
  }
}

// Durable dry-run intents only. This class has no WhatsApp transport and cannot send.
export class DisabledNotificationPlanner implements VacancyNotificationPlanner {
  constructor(private readonly client: SupabaseClient) {}
  async planMatches(vacancyId: number): Promise<number> {
    let planned = 0;
    // Bound memory while scanning persisted opt-in profiles. No automatic invocation or sending.
    for (let offset = 0; ; offset += 100) {
      const page = await this.client
        .from('job_seeker_preferences')
        .select('*')
        .eq('notifications_enabled', true)
        .order('profile_id')
        .range(offset, offset + 99);
      if (page.error) throw page.error;
      for (const pref of page.data ?? []) {
        if (!completePreference(pref)) continue;
        if (await this.plan(pref.profile_id, vacancyId)) planned++;
      }
      if ((page.data?.length ?? 0) < 100) break;
    }
    return planned;
  }
  async plan(profileId: string, vacancyId: number): Promise<boolean> {
    const pref = await this.client
      .from('job_seeker_preferences')
      .select('*')
      .eq('profile_id', profileId)
      .maybeSingle();
    if (pref.error) throw pref.error;
    if (!pref.data?.notifications_enabled || !completePreference(pref.data)) return false;
    const job = await matchingVacancies(this.client, pref.data).eq('id', vacancyId).maybeSingle();
    if (job.error) throw job.error;
    if (
      !job.data ||
      job.data.status !== 'active' ||
      (job.data.expires_at && job.data.expires_at <= new Date().toISOString())
    )
      return false;
    const { data, error } = await this.client
      .from('vacancy_notification_intents')
      .upsert(
        { profile_id: profileId, job_id: vacancyId, status: 'disabled' },
        { onConflict: 'profile_id,job_id', ignoreDuplicates: true },
      )
      .select('job_id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
}
