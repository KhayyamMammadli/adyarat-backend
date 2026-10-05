import { moderationButtons, formatTelegramJob } from '../telegram/job-message';
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { TelegramAdminService as TelegramNotifications } from '../telegram/telegram.service';

const PAGE_SIZE = 5;
const MODES: Record<string, string> = {
  '1': 'office',
  '2': 'remote',
  '3': 'hybrid',
  ofis: 'office',
  remote: 'remote',
  hibrid: 'hybrid',
};
const MENU = { id: 'job:menu', title: 'Əsas menyu' };
type Profile = { id: string; wa_id: string; display_name?: string; role?: string; state: string };
type Vacancy = {
  id: number;
  title: string;
  company_name?: string;
  location_name?: string;
  work_mode?: string;
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
  description?: string;
  contact_phone?: string;
  contact_email?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class JobAgentService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly telegram: TelegramNotifications,
  ) {}

  async welcome(waId: string, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    await this.setState(profile.id, 'ready');
    await this.whatsapp.sendJobMainMenu(waId, displayName);
  }

  async handleInteractive(waId: string, action: string, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    if (action === 'job:menu') {
      await this.welcome(waId, displayName);
      return;
    }
    // Only explicit interactive role IDs may interrupt a partially completed flow.
    if (action === 'job:seeker') {
      await this.savePreference(profile.id, {
        desired_title: null,
        location_name: null,
        salary_min: null,
        work_modes: [],
      });
      await this.setRole(profile.id, 'seeker', 'seeker_category');
      await this.prompt(
        waId,
        '🔎 Hansı iş/vəzifə üzrə iş axtarırsınız?\nMəsələn: Frontend developer, sürücü, mühasib',
      );
      return;
    }
    if (action === 'job:employer') {
      const employer = await this.employer(profile.id);
      await this.write(
        this.supabase.client.from('employer_profiles').upsert(
          {
            profile_id: profile.id,
            metadata: { ...(employer?.metadata ?? {}), draft_job_id: null },
            updated_at: this.now(),
          },
          { onConflict: 'profile_id' },
        ),
      );
      await this.setRole(profile.id, 'employer', 'employer_company');
      await this.prompt(waId, '🏢 Şirkətin adını yazın.');
      return;
    }
    if (action === 'job:all' || action === 'job:matches') {
      const mode = action === 'job:all' ? 'all' : 'matches';
      await this.setState(profile.id, `browse_${mode}`);
      await this.sendJobs(waId, profile.id, mode, 0);
      return;
    }
    if (action === 'job:profile') {
      await this.setState(profile.id, 'ready');
      await this.sendProfile(waId, profile);
      return;
    }
    const page = /^job:page:(all|matches):(\d{1,6})$/.exec(action);
    if (page && profile.state === `browse_${page[1]}`) {
      await this.sendJobs(waId, profile.id, page[1] as 'all' | 'matches', Number(page[2]));
      return;
    }
    const detail = /^job:detail:(all|matches):(\d{1,6}):(\d+)$/.exec(action);
    if (detail && profile.state === `browse_${detail[1]}`) {
      const { data, error } = await this.activeJobs().eq('id', Number(detail[3])).maybeSingle();
      if (error) throw error;
      if (data) await this.whatsapp.sendText(waId, this.formatJob(data));
      await this.whatsapp.sendJobButtons(
        waId,
        data
          ? 'Siyahıya qayıda və ya əsas menyunu aça bilərsiniz.'
          : 'Bu vakansiya artıq aktiv deyil.',
        [{ id: `job:page:${detail[1]}:${detail[2]}`, title: 'Siyahıya qayıt' }, MENU],
      );
      return;
    }
    const mode = /^job:mode:(seeker|employer):(office|remote|hybrid)$/.exec(action);
    if (mode && profile.state === `${mode[1]}_work_mode`) {
      await this.acceptMode(waId, profile, mode[2]);
      return;
    }
    const confirm = /^job:confirm:(\d+)$/.exec(action);
    if (confirm && profile.state === 'employer_confirm') {
      const draft = await this.draft(profile.id);
      if (String(draft.id) === confirm[1]) {
        await this.submit(waId, profile.id, draft);
        return;
      }
    }
    // Old buttons must never become free-text answers to a new flow.
    await this.prompt(
      waId,
      'Bu seçim artıq keçərli deyil. Cari suala cavab verin və ya əsas menyunu açın.',
    );
  }

  async handleText(waId: string, text: string, displayName?: string): Promise<boolean> {
    const raw = text.trim();
    const value = raw.toLocaleLowerCase('az');
    const profile = await this.upsertProfile(waId, displayName);
    if (['salam', 'hello', 'hi', 'menu', 'menyu', 'start'].includes(value)) {
      await this.welcome(waId, displayName);
      return true;
    }
    const limit =
      (
        {
          seeker_category: 120,
          seeker_location: 250,
          employer_company: 160,
          employer_job_title: 120,
          employer_location: 250,
        } as Record<string, number>
      )[profile.state] ?? 1500;
    if (!raw || raw.length > limit) {
      await this.prompt(waId, `Cavab 1–${limit} simvol arasında olmalıdır.`);
      return true;
    }
    if (profile.state === 'seeker_category') {
      await this.savePreference(profile.id, { desired_title: raw });
      await this.setState(profile.id, 'seeker_location');
      await this.prompt(waId, '📍 Hansı şəhər/rayonda iş axtarırsınız?');
    } else if (profile.state === 'seeker_location') {
      await this.savePreference(profile.id, { location_name: raw });
      await this.setState(profile.id, 'seeker_work_mode');
      await this.sendModes(waId, 'seeker');
    } else if (profile.state === 'seeker_work_mode' || profile.state === 'employer_work_mode') {
      const mode = MODES[value];
      if (mode) await this.acceptMode(waId, profile, mode);
      else await this.sendModes(waId, profile.state === 'seeker_work_mode' ? 'seeker' : 'employer');
    } else if (profile.state === 'seeker_salary') {
      const salary = this.number(raw);
      if (salary === undefined) {
        await this.prompt(waId, 'Maaşı rəqəmlə yazın. Məsələn: 1000');
        return true;
      }
      await this.savePreference(profile.id, { salary_min: salary });
      await this.setState(profile.id, 'ready');
      await this.whatsapp.sendText(waId, '✅ İş profiliniz saxlanıldı.');
      await this.whatsapp.sendJobMainMenu(waId);
    } else if (profile.state === 'employer_company') {
      await this.write(
        this.supabase.client
          .from('employer_profiles')
          .upsert(
            { profile_id: profile.id, company_name: raw, updated_at: this.now() },
            { onConflict: 'profile_id' },
          ),
      );
      await this.setState(profile.id, 'employer_job_title');
      await this.prompt(waId, '📢 Vakansiyanın adını yazın. Məsələn: Satış meneceri');
    } else if (profile.state === 'employer_job_title') {
      const employer = await this.employer(profile.id);
      const { data, error } = await this.supabase.client
        .from('jobs')
        .insert({
          source: 'whatsapp',
          title: raw,
          company_name: employer?.company_name,
          status: 'draft',
          metadata: { employer_profile_id: profile.id },
        })
        .select('*')
        .single();
      if (error) throw error;
      await this.write(
        this.supabase.client
          .from('employer_profiles')
          .update({
            metadata: { ...(employer?.metadata ?? {}), draft_job_id: data.id },
            updated_at: this.now(),
          })
          .eq('profile_id', profile.id),
      );
      await this.setState(profile.id, 'employer_location');
      await this.prompt(waId, '📍 Şəhər/rayon və iş yerinin ünvanını yazın.');
    } else if (profile.state === 'employer_location') {
      await this.updateDraft(profile.id, { location_name: raw });
      await this.setState(profile.id, 'employer_work_mode');
      await this.sendModes(waId, 'employer');
    } else if (profile.state === 'employer_salary_min' || profile.state === 'employer_salary_max') {
      const salary = this.number(raw);
      const draft = await this.draft(profile.id);
      const maximum = profile.state === 'employer_salary_max';
      if (salary === undefined || (maximum && salary < Number(draft.salary_min))) {
        await this.prompt(
          waId,
          maximum
            ? 'Maksimum maaşı rəqəmlə yazın; minimum maaşdan az olmamalıdır.'
            : 'Minimum maaşı rəqəmlə yazın. Məsələn: 800',
        );
        return true;
      }
      await this.updateDraft(profile.id, maximum ? { salary_max: salary } : { salary_min: salary });
      await this.setState(profile.id, maximum ? 'employer_description' : 'employer_salary_max');
      await this.prompt(
        waId,
        maximum
          ? '📝 Vakansiyanın təsvirini və əsas tələbləri yazın.'
          : '💰 Maksimum maaşı AZN ilə yazın.',
      );
    } else if (profile.state === 'employer_description') {
      await this.updateDraft(profile.id, { description: raw });
      await this.setState(profile.id, 'employer_contact');
      await this.prompt(waId, '☎️ Namizədlər üçün əlaqə nömrəsini yazın.');
    } else if (profile.state === 'employer_contact') {
      if (!/^\+?[\d\s()-]{7,25}$/.test(raw) || raw.replace(/\D/g, '').length < 7) {
        await this.prompt(waId, 'Düzgün əlaqə nömrəsi yazın. Məsələn: +994501234567');
        return true;
      }
      await this.updateDraft(profile.id, { contact_phone: raw });
      await this.setState(profile.id, 'employer_confirm');
      await this.sendConfirmation(waId, await this.draft(profile.id));
    } else if (profile.state === 'employer_confirm') {
      await this.sendConfirmation(waId, await this.draft(profile.id));
    } else {
      // Bare 1/2/3 have no global role meaning.
      await this.whatsapp.sendJobMainMenu(waId, displayName);
    }
    return true;
  }

  private async prompt(waId: string, body: string): Promise<void> {
    await this.whatsapp.sendJobButtons(waId, body, [MENU]);
  }
  private async sendModes(waId: string, role: string): Promise<void> {
    await this.whatsapp.sendJobList(
      waId,
      'İş rejimini seçin (və ya 1 — Ofis, 2 — Remote, 3 — Hibrid yazın).',
      [
        { id: `job:mode:${role}:office`, title: '🏢 Ofis' },
        { id: `job:mode:${role}:remote`, title: '🏠 Remote' },
        { id: `job:mode:${role}:hybrid`, title: '🔄 Hibrid' },
        MENU,
      ],
    );
  }
  private async acceptMode(waId: string, profile: Profile, mode: string): Promise<void> {
    const seeker = profile.state === 'seeker_work_mode';
    if (seeker) await this.savePreference(profile.id, { work_modes: [mode] });
    else await this.updateDraft(profile.id, { work_mode: mode });
    await this.setState(profile.id, seeker ? 'seeker_salary' : 'employer_salary_min');
    await this.prompt(
      waId,
      seeker ? '💰 Minimum maaş istəyinizi AZN ilə yazın.' : '💰 Minimum maaşı AZN ilə yazın.',
    );
  }
  private async sendConfirmation(waId: string, job: Vacancy): Promise<void> {
    await this.whatsapp.sendText(waId, this.formatJob(job));
    await this.whatsapp.sendJobButtons(
      waId,
      'Elanı yoxlayın. Təsdiq etdikdən sonra admin moderasiyasına göndəriləcək.',
      [
        { id: `job:confirm:${job.id}`, title: '✅ Təsdiq et' },
        { id: 'job:employer', title: 'Yenidən hazırla' },
        MENU,
      ],
    );
  }
  private async submit(waId: string, profileId: string, job: Vacancy): Promise<void> {
    await this.updateDraft(profileId, { status: 'pending' });
    await this.setState(profileId, 'ready');
    await this.telegram.sendMessage(
      `📋 Yeni vakansiya moderasiyaya göndərildi\n${formatTelegramJob(job)}`,
      moderationButtons(job.id),
    );
    await this.whatsapp.sendText(
      waId,
      '✅ Vakansiya yoxlanışa göndərildi. Admin təsdiqindən sonra aktiv olacaq.',
    );
    await this.whatsapp.sendJobMainMenu(waId);
  }
  private activeJobs() {
    return this.supabase.client
      .from('jobs')
      .select('*')
      .eq('status', 'active')
      .or(`expires_at.is.null,expires_at.gt.${this.now()}`);
  }
  private async sendJobs(
    waId: string,
    profileId: string,
    mode: 'all' | 'matches',
    page: number,
  ): Promise<void> {
    let query = this.activeJobs();
    if (mode === 'matches') {
      const pref = await this.preference(profileId);
      if (
        (!pref?.desired_title && !pref?.category_id) ||
        !pref?.location_name ||
        pref.salary_min == null
      ) {
        await this.whatsapp.sendJobButtons(
          waId,
          'Uyğun vakansiyalar üçün əvvəl iş profilinizi tamamlayın.',
          [{ id: 'job:seeker', title: '🔎 Profil yarat' }, MENU],
        );
        return;
      }
      if (pref.category_id && pref.desired_title) {
        query = query.or(
          `category_id.eq.${Number(pref.category_id)},title.ilike.${this.filterLike(pref.desired_title)}`,
        );
      } else if (pref.category_id) query = query.eq('category_id', pref.category_id);
      else query = query.ilike('title', `%${this.literalLike(pref.desired_title)}%`);
      // The exception belongs to the vacancy, not to all modes selected by the seeker.
      const city = pref.location_name.trim();
      const cities = /^(bakı|baki|baku)$/i.test(city) ? ['Bakı', 'Baki', 'Baku'] : [city];
      query = query.or(
        [
          'work_mode.eq.remote',
          ...cities.map((name) => `location_name.ilike.${this.filterLike(name)}`),
        ].join(','),
      );
      if (pref.work_modes?.length) query = query.in('work_mode', pref.work_modes);
      query = query.eq('salary_currency', pref.salary_currency ?? 'AZN');
      query = query.or(
        `salary_max.gte.${Number(pref.salary_min)},and(salary_max.is.null,salary_min.gte.${Number(pref.salary_min)})`,
      );
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    if (error) throw error;
    const jobs = (data ?? []) as Vacancy[];
    const rows = jobs.slice(0, PAGE_SIZE).map((job) => ({
      id: `job:detail:${mode}:${page}:${job.id}`,
      title: job.title.slice(0, 24),
      description:
        `${job.company_name ?? 'Şirkət'} • ${job.location_name ?? 'Lokasiya'} • ${this.salary(job)}`.slice(
          0,
          72,
        ),
    }));
    if (page > 0)
      rows.push({
        id: `job:page:${mode}:${page - 1}`,
        title: '⬅️ Geri',
        description: 'Əvvəlki səhifə',
      });
    if (jobs.length > PAGE_SIZE)
      rows.push({
        id: `job:page:${mode}:${page + 1}`,
        title: 'Növbəti ➡️',
        description: 'Növbəti səhifə',
      });
    rows.push({ ...MENU, description: 'Əsas menyuya qayıt' });
    // WhatsApp list rows are hidden behind its picker. Show the current page in chat too.
    if (jobs.length) {
      await this.whatsapp.sendText(
        waId,
        jobs
          .slice(0, PAGE_SIZE)
          .map(
            (job) =>
              `#${job.id} — ${job.title.slice(0, 120)}\n🏢 ${(job.company_name ?? 'Şirkət').slice(0, 160)}\n📍 ${(job.location_name ?? '-').slice(0, 250)} • ${job.work_mode ?? '-'}\n💰 ${this.salary(job)}`,
          )
          .join('\n\n'),
      );
    }
    await this.whatsapp.sendJobList(
      waId,
      jobs.length
        ? `${mode === 'all' ? '📋 Bütün aktiv vakansiyalar' : '🎯 Mənə uyğun vakansiyalar'} — səhifə ${page + 1}. Ətraflı baxmaq üçün elanı seçin.`
        : 'Hazırda bu səhifədə aktiv vakansiya yoxdur.',
      rows,
    );
  }
  private async sendProfile(waId: string, profile: Profile): Promise<void> {
    const pref = await this.preference(profile.id);
    const employer = await this.employer(profile.id);
    await this.whatsapp.sendText(
      waId,
      [
        `👤 ${profile.display_name ?? 'Profilim'}`,
        `Rol: ${profile.role === 'employer' ? 'İşəgötürən' : profile.role === 'seeker' ? 'İş axtaran' : 'Seçilməyib'}`,
        `İş: ${pref?.desired_title ?? 'Daxil edilməyib'}`,
        `Şəhər: ${pref?.location_name ?? 'Daxil edilməyib'}`,
        `İş rejimi: ${pref?.work_modes?.join(', ') || 'Daxil edilməyib'}`,
        `Minimum maaş: ${pref?.salary_min ?? 'Daxil edilməyib'} AZN`,
        `Şirkət: ${employer?.company_name ?? 'Daxil edilməyib'}`,
      ].join('\n'),
    );
    await this.whatsapp.sendJobMainMenu(waId);
  }
  private salary(job: Vacancy): string {
    return job.salary_min != null || job.salary_max != null
      ? `${job.salary_min ?? ''}${job.salary_min != null && job.salary_max != null ? '–' : ''}${job.salary_max ?? ''} ${job.salary_currency ?? 'AZN'}`
      : 'Maaş göstərilməyib';
  }
  private formatJob(job: Vacancy): string {
    return `#${job.id} — ${job.title.slice(0, 120)}\n🏢 ${(job.company_name ?? 'Şirkət').slice(0, 160)}\n📍 ${(job.location_name ?? '-').slice(0, 250)}\n💼 ${job.work_mode ?? '-'}\n💰 ${this.salary(job)}\n📝 ${(job.description ?? '-').slice(0, 1500)}\n☎️ ${(job.contact_phone ?? '-').slice(0, 25)}${job.contact_email ? `\n📧 ${job.contact_email.slice(0, 254)}` : ''}`;
  }
  private filterLike(value: string): string {
    // Quoted PostgREST values keep commas/parentheses in user input out of its grammar.
    return JSON.stringify(`%${this.literalLike(value)}%`);
  }
  private literalLike(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
  }
  private number(value: string): number | undefined {
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return undefined;
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 1000000 ? n : undefined;
  }
  private now(): string {
    return new Date().toISOString();
  }
  private async write(query: PromiseLike<{ error: any }>): Promise<void> {
    const { error } = await query;
    if (error) throw error;
  }
  private async preference(profileId: string): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('job_seeker_preferences')
      .select('*')
      .eq('profile_id', profileId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  private async employer(profileId: string): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('employer_profiles')
      .select('*')
      .eq('profile_id', profileId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  private async savePreference(profileId: string, patch: Record<string, unknown>): Promise<void> {
    await this.write(
      this.supabase.client
        .from('job_seeker_preferences')
        .upsert(
          { profile_id: profileId, ...patch, updated_at: this.now() },
          { onConflict: 'profile_id' },
        ),
    );
  }
  private async draft(profileId: string): Promise<Vacancy> {
    const employer = await this.employer(profileId);
    if (!employer?.metadata?.draft_job_id) throw new Error('Employer draft job not found');
    const { data, error } = await this.supabase.client
      .from('jobs')
      .select('*')
      .eq('id', employer.metadata.draft_job_id)
      .eq('status', 'draft')
      .contains('metadata', { employer_profile_id: profileId })
      .single();
    if (error) throw error;
    return data;
  }
  private async updateDraft(profileId: string, patch: Record<string, unknown>): Promise<void> {
    const job = await this.draft(profileId);
    const { error } = await this.supabase.client
      .from('jobs')
      .update({ ...patch, updated_at: this.now() })
      .eq('id', job.id)
      .eq('status', 'draft')
      .contains('metadata', { employer_profile_id: profileId })
      .select('id')
      .single();
    if (error) throw error;
  }
  private async upsertProfile(waId: string, displayName?: string): Promise<Profile> {
    const { data, error } = await this.supabase.client
      .from('job_agent_profiles')
      .upsert(
        {
          wa_id: waId,
          phone: waId,
          ...(displayName ? { display_name: displayName } : {}),
          updated_at: this.now(),
        },
        { onConflict: 'wa_id' },
      )
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }
  private async setRole(profileId: string, role: string, state: string): Promise<void> {
    await this.write(
      this.supabase.client
        .from('job_agent_profiles')
        .update({ role, state, updated_at: this.now() })
        .eq('id', profileId),
    );
  }
  private async setState(profileId: string, state: string): Promise<void> {
    await this.write(
      this.supabase.client
        .from('job_agent_profiles')
        .update({ state, updated_at: this.now() })
        .eq('id', profileId),
    );
  }
}
