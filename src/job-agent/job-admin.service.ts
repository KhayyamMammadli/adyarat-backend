import { publicationLabel } from './vacancy-lifecycle';
import { statisticsPeriod } from '../telegram/admin-statistics';
import { validCoordinates } from './vacancy-validation';
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';

@Injectable()
export class JobAdminService {
  private readonly logger = new Logger(JobAdminService.name);
  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
  ) {}

  async statistics(now = new Date()) {
    const count = async (query: any): Promise<number> => {
      const result = await query;
      if (result.error) throw result.error;
      if (typeof result.count !== 'number') throw new Error('Statistics count unavailable');
      return result.count;
    };
    const jobs = () =>
      this.supabase.client.from('jobs').select('id', { count: 'exact', head: true });
    const profiles = () =>
      this.supabase.client.from('job_agent_profiles').select('id', { count: 'exact', head: true });
    const day = statisticsPeriod('day', now),
      week = statisticsPeriod('week', now);
    const [totalJobs, activeJobs, pendingJobs, totalUsers, employers, seekers, today, thisWeek] =
      await Promise.all([
        count(jobs()),
        count(
          jobs().eq('status', 'active').or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`),
        ),
        count(jobs().eq('status', 'pending')),
        count(profiles()),
        count(profiles().eq('role', 'employer')),
        count(profiles().eq('role', 'seeker')),
        count(jobs().gte('created_at', day.from).lte('created_at', day.to)),
        count(jobs().gte('created_at', week.from).lte('created_at', week.to)),
      ]);
    const analytics = await this.supabase.client.rpc('vacancy_browse_statistics', {
      p_now: now.toISOString(),
    });
    if (analytics.error) throw analytics.error;
    return {
      totalJobs,
      activeJobs,
      pendingJobs,
      totalUsers,
      employers,
      seekers,
      today,
      thisWeek,
      browsing: analytics.data,
    };
  }

  async periodJobs(period: 'day' | 'week', page: number, now = new Date()): Promise<any[]> {
    const bounds = statisticsPeriod(period, now);
    const result = await this.supabase.client
      .from('jobs')
      .select('id,title,company_name,status,created_at')
      .gte('created_at', bounds.from)
      .lte('created_at', bounds.to)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * 5, page * 5 + 5);
    if (result.error) throw result.error;
    return result.data ?? [];
  }

  async pending(limit = 10): Promise<any[]> {
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select(
        'id,title,company_name,location_name,work_mode,salary_min,salary_max,salary_currency,description,contact_phone,contact_email,metadata,created_at,source,source_url,latitude,longitude,scheduled_at,approved_at,delete_at,revision',
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }

  async approve(jobId: number, revision = 1): Promise<any> {
    const job = await this.getPending(jobId, revision);
    const { data, error } = await this.supabase.client
      .from('jobs')
      .update({
        status:
          job.scheduled_at && Date.parse(job.scheduled_at) > Date.now() ? 'scheduled' : 'active',
        approved_at: new Date().toISOString(),
        published_at:
          job.scheduled_at && Date.parse(job.scheduled_at) > Date.now()
            ? null
            : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .match(job.revision != null ? { revision: job.revision } : {})
      .select('*')
      .single();
    if (error) throw error;
    await this.notifyEmployer(
      job,
      `✅ Vakansiyanız təsdiqləndi.\n${data.status === 'scheduled' ? publicationLabel(data) : 'Elan aktiv edildi.'}\n\n📢 ${job.title}`,
    );
    return data;
  }

  async reject(jobId: number, reason?: string, revision = 1): Promise<any> {
    const cleanReason = reason?.trim();
    if (!cleanReason || cleanReason.length > 500)
      throw new Error('Reject reason must contain 1–500 characters');
    const job = await this.getPending(jobId, revision);
    const metadata = { ...(job.metadata ?? {}), moderation_reason: cleanReason };
    const { data, error } = await this.supabase.client
      .from('jobs')
      .update({ status: 'rejected', metadata, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'pending')
      .match(job.revision != null ? { revision: job.revision } : {})
      .select('*')
      .single();
    if (error) throw error;
    const suffix = reason?.trim() ? `\nSəbəb: ${reason.trim()}` : '';
    await this.notifyEmployer(
      job,
      `❌ Vakansiyanız təsdiqlənmədi.\n\n📢 ${job.title}${suffix}\n\nDüzəliş edib yenidən yaratmaq üçün aşağıdakı menyudan seçim edin.`,
    );
    return data;
  }

  async createActive(
    draft: Record<string, unknown>,
    sourceId: string,
    userId: number,
  ): Promise<any> {
    if (['office', 'hybrid'].includes(String(draft.work_mode)) && !validCoordinates(draft))
      throw new Error('Office/Hybrid vacancy requires coordinates');
    const row = {
      ...draft,
      source: 'telegram_admin',
      source_id: sourceId,
      status:
        draft.scheduled_at && Date.parse(String(draft.scheduled_at)) > Date.now()
          ? 'scheduled'
          : 'active',
      approved_at: new Date().toISOString(),
      published_at:
        draft.scheduled_at && Date.parse(String(draft.scheduled_at)) > Date.now()
          ? null
          : new Date().toISOString(),
      metadata: { telegram_admin_user_id: userId },
    };
    const { data, error } = await this.supabase.client
      .from('jobs')
      .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
    const existing = await this.supabase.client
      .from('jobs')
      .select('*')
      .eq('source', 'telegram_admin')
      .eq('source_id', sourceId)
      .single();
    if (existing.error) throw existing.error;
    return existing.data;
  }

  async getPending(jobId: number, revision = 1): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('status', 'pending')
      .maybeSingle();
    if (error) throw error;
    if (
      !data ||
      (data.revision ?? 1) !== revision ||
      (data.delete_at && Date.parse(data.delete_at) <= Date.now())
    )
      throw new Error(`Pending vacancy #${jobId} not found or revision changed`);
    return data;
  }

  private async notifyEmployer(job: any, text: string): Promise<void> {
    const profileId = job.metadata?.employer_profile_id;
    if (!profileId) return;
    try {
      const { data: profile, error } = await this.supabase.client
        .from('job_agent_profiles')
        .select('wa_id')
        .eq('id', profileId)
        .maybeSingle();
      if (error) throw error;
      if (profile?.wa_id) {
        await this.whatsapp.sendText(profile.wa_id, text);
        await this.whatsapp.sendJobMainMenu(profile.wa_id);
      }
    } catch {
      this.logger.warn(`Vacancy #${job.id} moderated, but employer notification failed`);
    }
  }
}
