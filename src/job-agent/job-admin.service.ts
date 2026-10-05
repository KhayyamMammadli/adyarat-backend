import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';

@Injectable()
export class JobAdminService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
  ) {}

  async pending(limit = 10): Promise<any[]> {
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select('id,title,company_name,location_name,work_mode,salary_min,salary_max,salary_currency,description,contact_phone,metadata,created_at')
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
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .single();
    if (error) throw error;
    await this.notifyEmployer(job, `✅ Vakansiyanız təsdiqləndi və aktiv edildi.\n\n📢 ${job.title}`);
    return data;
  }

  async reject(jobId: number, reason?: string): Promise<any> {
    const job = await this.getPending(jobId);
    const metadata = { ...(job.metadata ?? {}), moderation_reason: reason?.trim() || undefined };
    const { data, error } = await this.supabase.client
      .from('jobs')
      .update({ status: 'rejected', metadata, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .single();
    if (error) throw error;
    const suffix = reason?.trim() ? `\nSəbəb: ${reason.trim()}` : '';
    await this.notifyEmployer(job, `❌ Vakansiyanız təsdiqlənmədi.\n\n📢 ${job.title}${suffix}\n\nDüzəliş edib yenidən yaratmaq üçün “Menyu” yazın.`);
    return data;
  }

  private async getPending(jobId: number): Promise<any> {
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
    const { data: profile } = await this.supabase.client
      .from('job_agent_profiles')
      .select('wa_id')
      .eq('id', profileId)
      .maybeSingle();
    if (profile?.wa_id) await this.whatsapp.sendText(profile.wa_id, text);
  }
}
