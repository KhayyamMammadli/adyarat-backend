import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';

@Injectable()
export class JobAgentService {
  private readonly logger = new Logger(JobAgentService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
  ) {}

  async welcome(waId: string, displayName?: string): Promise<void> {
    await this.upsertProfile(waId, displayName);
    await this.whatsapp.sendText(
      waId,
      [
        displayName ? `Salam, ${displayName}! 👋` : 'Salam! 👋',
        '',
        'Vakansiya xidmətinə xoş gəlmisiniz.',
        '',
        '1️⃣ İş axtarıram',
        '2️⃣ İşçi axtarıram',
        '',
        'Davam etmək üçün 1 və ya 2 yazın.',
      ].join('\n'),
    );
  }

  async handleText(waId: string, text: string, displayName?: string): Promise<boolean> {
    const value = text.trim().toLocaleLowerCase('az');
    const profile = await this.upsertProfile(waId, displayName);

    if (['salam', 'hello', 'hi', 'menu', 'menyu', 'start'].includes(value)) {
      await this.welcome(waId, displayName);
      return true;
    }

    if (value === '1' || value.includes('iş axtarıram') || value.includes('is axtariram')) {
      await this.setRole(profile.id, 'seeker', 'seeker_category');
      await this.whatsapp.sendText(
        waId,
        '🔎 Əla. Hansı iş/vəzifə üzrə iş axtarırsınız?\n\nMəsələn: Frontend developer, sürücü, mühasib',
      );
      return true;
    }

    if (value === '2' || value.includes('işçi axtarıram') || value.includes('isci axtariram')) {
      await this.setRole(profile.id, 'employer', 'employer_company');
      await this.whatsapp.sendText(
        waId,
        '🏢 Əla. Şirkətin adını yazın.',
      );
      return true;
    }

    if (profile.state === 'seeker_category') {
      await this.supabase.client.from('job_seeker_preferences').upsert({
        profile_id: profile.id,
        desired_title: text.trim(),
        updated_at: new Date().toISOString(),
      });
      await this.setState(profile.id, 'seeker_location');
      await this.whatsapp.sendText(waId, '📍 Hansı şəhər/rayonda iş axtarırsınız?');
      return true;
    }

    if (profile.state === 'seeker_location') {
      await this.supabase.client.from('job_seeker_preferences').upsert({
        profile_id: profile.id,
        location_name: text.trim(),
        updated_at: new Date().toISOString(),
      });
      await this.setState(profile.id, 'seeker_salary');
      await this.whatsapp.sendText(waId, '💰 Minimum maaş istəyinizi AZN ilə yazın. Məsələn: 1000');
      return true;
    }

    if (profile.state === 'seeker_salary') {
      const salary = Number(text.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(salary) || salary <= 0) {
        await this.whatsapp.sendText(waId, 'Maaşı rəqəmlə yazın. Məsələn: 1000');
        return true;
      }
      await this.supabase.client.from('job_seeker_preferences').upsert({
        profile_id: profile.id,
        salary_min: salary,
        updated_at: new Date().toISOString(),
      });
      await this.setState(profile.id, 'ready');
      await this.sendMatches(waId, profile.id);
      return true;
    }

    if (profile.state === 'employer_company') {
      await this.supabase.client.from('employer_profiles').upsert({
        profile_id: profile.id,
        company_name: text.trim(),
        updated_at: new Date().toISOString(),
      });
      await this.setState(profile.id, 'employer_job_title');
      await this.whatsapp.sendText(waId, '📢 Yerləşdirmək istədiyiniz vakansiyanın adını yazın.');
      return true;
    }

    if (profile.state === 'employer_job_title') {
      await this.supabase.client.from('jobs').insert({
        source: 'whatsapp',
        title: text.trim(),
        status: 'draft',
        metadata: { employer_profile_id: profile.id },
      });
      await this.setState(profile.id, 'ready');
      await this.whatsapp.sendText(
        waId,
        '✅ Vakansiya qaralama kimi yaradıldı. Növbəti mərhələdə maaş, iş rejimi, lokasiya və təsvir məlumatlarını tamamlayacağıq.',
      );
      return true;
    }

    await this.welcome(waId, displayName);
    return true;
  }

  private async sendMatches(waId: string, profileId: string): Promise<void> {
    const { data: preference } = await this.supabase.client
      .from('job_seeker_preferences')
      .select('*')
      .eq('profile_id', profileId)
      .maybeSingle();

    let query = this.supabase.client
      .from('jobs')
      .select('id,title,company_name,location_name,salary_min,salary_max,salary_currency')
      .eq('status', 'active')
      .limit(5);

    if (preference?.desired_title) {
      query = query.ilike('title', `%${preference.desired_title}%`);
    }
    if (preference?.location_name) {
      query = query.ilike('location_name', `%${preference.location_name}%`);
    }

    const { data: jobs, error } = await query;
    if (error) this.logger.warn(`Job search failed: ${error.message}`);

    if (!jobs?.length) {
      await this.whatsapp.sendText(
        waId,
        '✅ İş profiliniz yaradıldı. Hazırda uyğun aktiv vakansiya tapılmadı. Yeni uyğun vakansiyalar əlavə olunduqca bu profil üzrə istifadə edə biləcəyik.',
      );
      return;
    }

    const lines = jobs.map((job, index) => {
      const salary = job.salary_min || job.salary_max
        ? `${job.salary_min ?? ''}${job.salary_min && job.salary_max ? '–' : ''}${job.salary_max ?? ''} ${job.salary_currency ?? 'AZN'}`
        : 'Maaş göstərilməyib';
      return `${index + 1}. ${job.title}\n🏢 ${job.company_name ?? 'Şirkət'}\n📍 ${job.location_name ?? 'Lokasiya göstərilməyib'}\n💰 ${salary}`;
    });

    await this.whatsapp.sendText(waId, ['🎯 Sizə uyğun vakansiyalar:', '', ...lines].join('\n\n'));
  }

  private async upsertProfile(waId: string, displayName?: string): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('job_agent_profiles')
      .upsert(
        {
          wa_id: waId,
          phone: waId,
          ...(displayName ? { display_name: displayName } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'wa_id' },
      )
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  private async setRole(profileId: string, role: 'seeker' | 'employer', state: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('job_agent_profiles')
      .update({ role, state, updated_at: new Date().toISOString() })
      .eq('id', profileId);
    if (error) throw error;
  }

  private async setState(profileId: string, state: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('job_agent_profiles')
      .update({ state, updated_at: new Date().toISOString() })
      .eq('id', profileId);
    if (error) throw error;
  }
}
