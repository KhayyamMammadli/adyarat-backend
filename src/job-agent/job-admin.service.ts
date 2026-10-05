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

  async pending(limit = 10): Promise<any[]> {
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select(
        'id,title,company_name,location_name,work_mode,salary_min,salary_max,salary_currency,description,contact_phone,contact_email,metadata,created_at',
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }

  async approve(jobId: number): Promise<any> {
    const job = await this.getPending(jobId);
    const { data, error } = await this.supabase.client
      .from('jobs')
      .update({
        status: 'active',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .single();
    if (error) throw error;
    await this.notifyEmployer(
      job,
      `✅ Vakansiyanız təsdiqləndi və aktiv edildi.\n\n📢 ${job.title}`,
    );
    return data;
  }

  async reject(jobId: number, reason?: string): Promise<any> {
    const cleanReason = reason?.trim();
    if (!cleanReason || cleanReason.length > 500)
      throw new Error('Reject reason must contain 1–500 characters');
    const job = await this.getPending(jobId);
    const metadata = { ...(job.metadata ?? {}), moderation_reason: cleanReason };
    const { data, error } = await this.supabase.client
      .from('jobs')
      .update({ status: 'rejected', metadata, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'pending')
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
    const row = {
      ...draft,
      source: 'telegram_admin',
      source_id: sourceId,
      status: 'active',
      published_at: new Date().toISOString(),
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

  async getPending(jobId: number): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('status', 'pending')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Pending vacancy #${jobId} not found`);
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
