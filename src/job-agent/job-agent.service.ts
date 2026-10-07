import { VacancyManagementService } from './vacancy-management.service';
import { parsePublicationTime, retentionDeadline, publicationLabel } from './vacancy-lifecycle';
import { BusinessRegistrationService } from './business-registration.service';
import { validPhone, validCoordinates, mapsLink } from './vacancy-validation';
import {
  activeVacancies,
  matchingVacancies,
  completePreference,
  filterLike,
  filteredVacancies,
} from './vacancy-query';
import { moderationButtons, formatTelegramJob } from '../telegram/job-message';
import { Injectable, Optional } from '@nestjs/common';
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
type Profile = {
  id: string;
  wa_id: string;
  display_name?: string;
  role?: string;
  state: string;
  browse_filters?: Record<string, any>;
  contact_email?: string;
  contact_phone?: string;
};
type Vacancy = {
  id: number;
  title: string;
  company_name?: string;
  location_name?: string;
  latitude?: number;
  longitude?: number;
  work_mode?: string;
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
  description?: string;
  contact_phone?: string;
  contact_email?: string;
  source?: string;
  source_url?: string;
  metadata?: Record<string, any>;
  scheduled_at?: string | null;
  created_at?: string;
  delete_at?: string;
  revision?: number;
};

@Injectable()
export class JobAgentService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly telegram: TelegramNotifications,
    private readonly businesses: BusinessRegistrationService,
    @Optional() private readonly management?: VacancyManagementService,
  ) {}

  async welcome(waId: string, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    await this.resetBrowse(profile.id);
    await this.setState(profile.id, 'ready');
    await this.sendMainMenu(waId, displayName);
  }

  async sendMainMenu(waId: string, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    let role: 'seeker' | 'employer' | undefined;
    if (
      profile.role === 'seeker' &&
      profile.contact_email &&
      profile.contact_phone &&
      completePreference(await this.preference(profile.id))
    )
      role = 'seeker';
    if (profile.role === 'employer') {
      const employer = await this.employer(profile.id);
      if (['pending', 'approved', 'rejected'].includes(employer?.registration_status))
        role = 'employer';
    }
    await this.whatsapp.sendJobMainMenu(waId, displayName, role);
  }

  async handleInteractive(waId: string, action: string, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    if (action === 'job:menu') {
      await this.welcome(waId, displayName);
      return;
    }
    if (this.management && (await this.management.interactive(profile, action))) return;
    if (profile.state === 'employer_confirm' && action === 'job:schedule:later') {
      await this.setState(profile.id, 'employer_schedule');
      await this.prompt(
        waId,
        'Bakı vaxtı ilə gələcək tarix yazın: DD.MM.YYYY HH:mm. Elan yaradıldıqdan 28 gün ərzində yayımlana bilər.',
      );
      return;
    }
    if (profile.state === 'employer_confirm' && action === 'job:schedule:now') {
      await this.updateDraft(profile.id, { scheduled_at: null });
      await this.sendConfirmation(waId, await this.draft(profile.id));
      return;
    }
    // Only explicit interactive role IDs may interrupt a partially completed flow.
    if (action === 'job:seeker') {
      await this.resetBrowse(profile.id);
      await this.savePreference(profile.id, {
        desired_title: null,
        category_id: null,
        latitude: null,
        longitude: null,
        radius_km: null,
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
    if (await this.businesses.interactive(profile, action)) return;
    if (action === 'job:employer') {
      await this.resetBrowse(profile.id);
      const employer = await this.employer(profile.id);
      await this.write(
        this.supabase.client.from('employer_profiles').upsert(
          {
            profile_id: profile.id,
            metadata: {
              ...(employer?.metadata ?? {}),
              draft_job_id: null,
              onboarding_return: null,
              location_return: null,
            },
            updated_at: this.now(),
          },
          { onConflict: 'profile_id' },
        ),
      );
      await this.setRole(profile.id, 'employer', 'employer_ready');
      await this.requireEmployer(waId, profile.id);
      return;
    }
    if (
      action === 'job:employer:new' &&
      profile.role === 'employer' &&
      ['ready', 'employer_ready', 'employer_confirm'].includes(profile.state)
    ) {
      const employer = await this.employer(profile.id);
      await this.saveEmployer(profile.id, {
        metadata: { ...(employer?.metadata ?? {}), draft_job_id: null, location_return: null },
      });
      await this.requireEmployer(waId, profile.id, 'employer_job_title');
      return;
    }
    if (action === 'job:filters') {
      await this.filterMenu(waId, profile);
      return;
    }
    if (action === 'job:all' || action === 'job:matches') {
      const mode = action === 'job:all' ? 'all' : 'matches';
      await this.setState(profile.id, `browse_${mode}`);
      await this.sendJobs(waId, profile.id, mode, 0);
      return;
    }
    if (action === 'job:profile') {
      await this.resetBrowse(profile.id);
      await this.setState(profile.id, 'ready');
      await this.sendProfile(waId, profile);
      return;
    }
    if (action === 'job:contact:add' && profile.state === 'employer_contact_choice') {
      await this.setState(profile.id, 'employer_contact');
      await this.prompt(waId, '📱 Public əlaqə nömrəsini yazın.');
      return;
    }
    if (
      action === 'job:contact:skip' &&
      ['employer_contact_choice', 'employer_contact'].includes(profile.state)
    ) {
      await this.updateDraft(profile.id, { contact_phone: null });
      await this.setState(profile.id, 'employer_confirm');
      await this.sendConfirmation(waId, await this.draft(profile.id));
      return;
    }
    if (
      action.startsWith('job:filter:') &&
      (profile.state === 'browse_all' || profile.state.startsWith('filter_'))
    ) {
      await this.handleFilter(waId, profile, action);
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
      if (data) {
        await this.whatsapp.sendText(waId, this.formatJob(data));
        if (['office', 'hybrid'].includes(data.work_mode) && validCoordinates(data)) {
          try {
            await this.whatsapp.sendJobLocation(
              waId,
              data.latitude,
              data.longitude,
              data.company_name,
              data.location_name,
            );
          } catch {
            // The text above already contains a complete clickable Maps fallback.
          }
        }
      }
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
    if (this.management && (await this.management.text(profile, raw))) return true;
    if (profile.state === 'employer_schedule') {
      const job = await this.draft(profile.id);
      const scheduled_at = parsePublicationTime(raw, retentionDeadline(job));
      if (!scheduled_at) {
        await this.prompt(
          waId,
          'Gələcək tarix və saat yazın: DD.MM.YYYY HH:mm (Bakı). Tarix 28 günlük müddətin daxilində olmalıdır.',
        );
        return true;
      }
      await this.updateDraft(profile.id, { scheduled_at });
      await this.setState(profile.id, 'employer_confirm');
      await this.sendConfirmation(waId, await this.draft(profile.id));
      return true;
    }
    if (await this.businesses.text(profile, raw)) return true;
    if (['seeker_email', 'seeker_phone'].includes(profile.state)) {
      if (
        await this.businesses.claimContact(
          profile,
          profile.state === 'seeker_email' ? 'email' : 'phone',
          raw,
        )
      )
        await this.businesses.seekerContact(profile);
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
      await this.businesses.seekerContact(profile);
    } else if (profile.state === 'employer_job_title') {
      const employer = await this.employer(profile.id);
      if (!(await this.businesses.isApproved(profile.id))) {
        await this.requireEmployer(waId, profile.id);
        return true;
      }
      const { data, error } = await this.supabase.client
        .from('jobs')
        .insert({
          source: 'whatsapp',
          title: raw,
          company_name: employer?.company_name,
          status: 'draft',
          contact_email: profile.contact_email,
          metadata: { employer_profile_id: profile.id, business_registration_version: 1 },
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
      await this.setState(profile.id, 'employer_contact_choice');
      await this.whatsapp.sendJobButtons(waId, 'Public əlaqə nömrəsi əlavə etmək istəyirsiniz?', [
        { id: 'job:contact:add', title: '📱 Nömrə əlavə et' },
        { id: 'job:contact:skip', title: '⏭️ Keç' },
        MENU,
      ]);
    } else if (profile.state === 'employer_contact') {
      if (!validPhone(raw)) {
        await this.prompt(waId, 'Düzgün əlaqə nömrəsi yazın. Məsələn: +994501234567');
        return true;
      }
      await this.updateDraft(profile.id, { contact_phone: raw });
      await this.setState(profile.id, 'employer_confirm');
      await this.sendConfirmation(waId, await this.draft(profile.id));
    } else if (profile.state.startsWith('filter_')) {
      await this.filterText(waId, profile, raw);
    } else if (profile.state === 'employer_pin') {
      await this.prompt(
        waId,
        '📍 WhatsApp-da 📎 → Location ilə iş yerinin dəqiq məkanını göndərin.',
      );
    } else if (profile.state === 'employer_confirm') {
      await this.sendConfirmation(waId, await this.draft(profile.id));
    } else {
      // Bare 1/2/3 have no global role meaning.
      await this.sendMainMenu(waId, displayName);
    }
    return true;
  }

  async handleLocation(waId: string, location: any, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    if (!validCoordinates(location)) {
      await this.prompt(waId, 'Düzgün xəritə lokasiyası göndərin.');
      return;
    }
    if (this.management && (await this.management.location(profile, location))) return;
    const coordinates = { latitude: location.latitude, longitude: location.longitude };
    if (profile.state === 'employer_pin') {
      const job = await this.draft(profile.id);
      await this.updateDraft(profile.id, {
        ...coordinates,
        location_name: String(location.address || location.name || job.location_name || '').slice(
          0,
          250,
        ),
      });
      const employer = await this.employer(profile.id);
      if (employer?.metadata?.location_return === 'employer_confirm') {
        await this.saveEmployer(profile.id, {
          metadata: { ...employer.metadata, location_return: null },
        });
        await this.setState(profile.id, 'employer_confirm');
        await this.sendConfirmation(waId, await this.draft(profile.id));
        return;
      }
      await this.setState(profile.id, 'employer_salary_min');
      await this.prompt(waId, '💰 Minimum maaşı AZN ilə yazın.');
    } else if (profile.state === 'filter_center') {
      await this.saveFilters(profile.id, { ...(profile.browse_filters ?? {}), ...coordinates });
      await this.setState(profile.id, 'filter_radius');
      await this.whatsapp.sendJobList(
        waId,
        'Məsafəni seçin.',
        [5, 10, 25, 50, 100]
          .map((n) => ({ id: `job:filter:radius:${n}`, title: `${n} km` }))
          .concat([MENU]),
      );
    } else await this.prompt(waId, 'Lokasiya cari addımda tələb olunmur. Cari suala cavab verin.');
  }
  private async saveEmployer(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.write(
      this.supabase.client
        .from('employer_profiles')
        .upsert({ profile_id: id, ...patch, updated_at: this.now() }, { onConflict: 'profile_id' }),
    );
  }
  private async requireEmployer(waId: string, id: string, resume?: string): Promise<void> {
    if (resume && (await this.businesses.isApproved(id))) {
      await this.setState(id, resume);
      if (resume === 'employer_confirm') await this.sendConfirmation(waId, await this.draft(id));
      else await this.prompt(waId, '📢 Vakansiyanın adını yazın.');
      return;
    }
    await this.businesses.require(waId, id);
  }
  async handleImage(waId: string, image: { id: string }, displayName?: string): Promise<void> {
    const profile = await this.upsertProfile(waId, displayName);
    await this.businesses.image(profile, image.id);
  }
  private async saveFilters(id: string, filters: Record<string, unknown>): Promise<void> {
    await this.write(
      this.supabase.client
        .from('job_agent_profiles')
        .update({ browse_filters: filters })
        .eq('id', id),
    );
  }
  private async resetBrowse(id: string): Promise<void> {
    await this.saveFilters(id, {});
  }
  private async filterMenu(waId: string, profile: Profile): Promise<void> {
    await this.setState(profile.id, 'filter_menu');
    const f = profile.browse_filters ?? {};
    await this.whatsapp.sendJobList(
      waId,
      `🔍 Filterlər: ${f.title || '-'} • ${f.location_name || '-'} • ${f.salary_min ?? '-'} AZN • ${f.work_mode || '-'} • ${f.radius_km ? `${f.radius_km} km` : '-'}`,
      [
        { id: 'job:filter:title', title: 'Vəzifə' },
        { id: 'job:filter:category', title: 'Kateqoriya' },
        { id: 'job:filter:city', title: 'Şəhər / lokasiya' },
        { id: 'job:filter:salary', title: 'Minimum maaş' },
        { id: 'job:filter:mode', title: 'İş rejimi' },
        { id: 'job:filter:center', title: '📍 Məsafə / radius' },
        { id: 'job:filter:apply', title: '🔍 Filterlə' },
        { id: 'job:filter:clear', title: '🧹 Filterləri təmizlə' },
        MENU,
      ],
    );
  }
  private async handleFilter(waId: string, profile: Profile, action: string): Promise<void> {
    const f = profile.browse_filters ?? {};
    if (action === 'job:filter:clear' || action === 'job:filter:apply') {
      if (action.endsWith(':clear')) await this.resetBrowse(profile.id);
      await this.setState(profile.id, 'browse_all');
      await this.sendJobs(waId, profile.id, 'all', 0);
      return;
    }
    if (action === 'job:filter:menu') {
      await this.filterMenu(waId, profile);
      return;
    }
    if (profile.state === 'filter_menu' || profile.state === 'browse_all') {
      const prompts: Record<string, string> = {
        title: 'Vəzifənin adını yazın.',
        city: 'Şəhər / rayon / ünvan yazın.',
        salary: 'Minimum maaşı AZN ilə yazın.',
        center: '📍 WhatsApp-da 📎 → Location ilə axtarış mərkəzini göndərin.',
      };
      const key = action.slice('job:filter:'.length);
      if (key === 'city') {
        await this.setState(profile.id, 'filter_city');
        await this.whatsapp.sendJobList(
          waId,
          'Hansı şəhərdə iş axtarırsınız?',
          ['Bakı', 'Sumqayıt', 'Gəncə', 'Abşeron', 'İsmayıllı']
            .map((city, i) => ({ id: `job:filter:city:${i}`, title: city }))
            .concat([{ id: 'job:filter:city:other', title: 'Başqa şəhər / ünvan' }, MENU]),
        );
        return;
      }
      if (prompts[key]) {
        await this.setState(profile.id, `filter_${key}`);
        await this.prompt(waId, prompts[key]);
        return;
      }
      if (key === 'mode') {
        await this.setState(profile.id, 'filter_mode');
        await this.whatsapp.sendJobList(
          waId,
          'İş rejimini seçin.',
          ['office', 'remote', 'hybrid']
            .map((mode, i) => ({
              id: `job:filter:mode:${mode}`,
              title: ['🏢 Ofis', '🏠 Remote', '🔄 Hibrid'][i],
            }))
            .concat([MENU]),
        );
        return;
      }
      if (key === 'category') {
        await this.categoryPage(waId, profile.id, 0);
        return;
      }
    }
    const city = /^job:filter:city:(\d|other)$/.exec(action);
    if (city && profile.state === 'filter_city') {
      if (city[1] === 'other') {
        await this.prompt(waId, 'Şəhəri və ya ünvanı yazın.');
        return;
      }
      const name = ['Bakı', 'Sumqayıt', 'Gəncə', 'Abşeron', 'İsmayıllı'][Number(city[1])];
      if (name) {
        await this.saveFilters(profile.id, { ...f, location_name: name });
        await this.setState(profile.id, 'browse_all');
        await this.sendJobs(waId, profile.id, 'all', 0);
        return;
      }
    }
    const categoryPage = /^job:filter:categories:(\d{1,6})$/.exec(action);
    if (categoryPage && profile.state === 'filter_category') {
      await this.categoryPage(waId, profile.id, Number(categoryPage[1]));
      return;
    }
    const cat = /^job:filter:category:(\d+)$/.exec(action);
    if (cat && profile.state === 'filter_category') {
      const result = await this.supabase.client
        .from('job_categories')
        .select('id')
        .eq('id', Number(cat[1]))
        .eq('is_active', true)
        .maybeSingle();
      if (result.error) throw result.error;
      if (result.data) {
        await this.saveFilters(profile.id, { ...f, category_id: Number(cat[1]), title: null });
        await this.setState(profile.id, 'browse_all');
        await this.sendJobs(waId, profile.id, 'all', 0);
        return;
      }
    }
    const mode = /^job:filter:mode:(office|remote|hybrid)$/.exec(action);
    const radius = /^job:filter:radius:(5|10|25|50|100)$/.exec(action);
    const patch =
      mode && profile.state === 'filter_mode'
        ? { work_mode: mode[1] }
        : radius && profile.state === 'filter_radius' && validCoordinates(f)
          ? { radius_km: Number(radius[1]) }
          : undefined;
    if (patch) {
      const filters = { ...f, ...patch };
      await this.saveFilters(profile.id, filters);
      await this.setState(profile.id, 'browse_all');
      await this.sendJobs(waId, profile.id, 'all', 0);
      return;
    }
    await this.prompt(waId, 'Bu seçim cari addıma aid deyil.');
  }
  private async categoryPage(waId: string, id: string, page: number): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('job_categories')
      .select('id,name')
      .eq('is_active', true)
      .order('id')
      .range(page * 6, page * 6 + 6);
    if (error) throw error;
    await this.setState(id, 'filter_category');
    const rows: Array<{ id: string; title: string; description?: string }> = (data ?? [])
      .slice(0, 6)
      .map((c) => ({
        id: `job:filter:category:${c.id}`,
        title: String(c.name).slice(0, 24),
        description: String(c.name).slice(0, 72),
      }));
    if (page) rows.push({ id: `job:filter:categories:${page - 1}`, title: '⬅️ Geri' });
    if ((data?.length ?? 0) > 6)
      rows.push({ id: `job:filter:categories:${page + 1}`, title: 'Növbəti ➡️' });
    rows.push({ id: 'job:filter:menu', title: 'Filterlərə qayıt' }, MENU);
    await this.whatsapp.sendJobList(waId, 'Kateqoriyanı seçin.', rows);
  }
  private async filterText(waId: string, profile: Profile, raw: string): Promise<void> {
    const f = profile.browse_filters ?? {};
    const patch =
      profile.state === 'filter_title' && raw.length <= 120
        ? { title: raw, category_id: null }
        : profile.state === 'filter_city' && raw.length <= 250
          ? { location_name: raw }
          : profile.state === 'filter_salary' && this.number(raw) !== undefined
            ? { salary_min: this.number(raw) }
            : undefined;
    if (!patch) {
      await this.prompt(
        waId,
        'Cari addım üçün düzgün məlumat daxil edin və ya düymədən seçim edin.',
      );
      return;
    }
    const filters = { ...f, ...patch };
    await this.saveFilters(profile.id, filters);
    await this.setState(profile.id, 'browse_all');
    await this.sendJobs(waId, profile.id, 'all', 0);
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
    if (!seeker && mode !== 'remote') {
      await this.setState(profile.id, 'employer_pin');
      await this.prompt(
        waId,
        '📍 WhatsApp-da 📎 → Location ilə iş yerinin dəqiq məkanını göndərin.',
      );
      return;
    }
    await this.setState(profile.id, seeker ? 'seeker_salary' : 'employer_salary_min');
    await this.prompt(
      waId,
      seeker ? '💰 Minimum maaş istəyinizi AZN ilə yazın.' : '💰 Minimum maaşı AZN ilə yazın.',
    );
  }
  private async sendConfirmation(waId: string, job: Vacancy): Promise<void> {
    await this.whatsapp.sendText(waId, this.formatJob(job));
    await this.whatsapp.sendJobList(
      waId,
      `Elanı yoxlayın. Təsdiq etdikdən sonra admin moderasiyasına göndəriləcək.\n${publicationLabel(job)}`,
      [
        { id: `job:confirm:${job.id}`, title: '✅ Təsdiq et' },
        { id: 'job:schedule:later', title: '📅 Tarixə planla' },
        { id: 'job:schedule:now', title: 'Dərhal yayımla' },
        { id: 'job:employer:new', title: 'Yenidən hazırla' },
        MENU,
      ],
    );
  }
  private async submit(waId: string, profileId: string, job: Vacancy): Promise<void> {
    const employer = await this.employer(profileId);
    if (!(await this.businesses.isApproved(profileId))) {
      await this.requireEmployer(waId, profileId, 'employer_confirm');
      return;
    }
    if (['office', 'hybrid'].includes(job.work_mode ?? '') && !validCoordinates(job)) {
      await this.saveEmployer(profileId, {
        metadata: { ...(employer?.metadata ?? {}), location_return: 'employer_confirm' },
      });
      await this.setState(profileId, 'employer_pin');
      await this.prompt(waId, '📍 İş yerinin dəqiq lokasiyasını göndərin.');
      return;
    }
    await this.updateDraft(profileId, {
      status: 'pending',
      metadata: { ...(job.metadata ?? {}), business_registration_version: 1 },
    });
    await this.setState(profileId, 'ready');
    await this.telegram.sendMessage(
      `📋 Yeni vakansiya moderasiyaya göndərildi\n${formatTelegramJob(job)}`,
      moderationButtons(job.id, job.revision),
    );
    await this.whatsapp.sendText(
      waId,
      '✅ Vakansiya yoxlanışa göndərildi. Admin təsdiqindən sonra aktiv olacaq.',
    );
    await this.sendMainMenu(waId);
  }
  private activeJobs() {
    return activeVacancies(this.supabase.client);
  }
  private async sendJobs(
    waId: string,
    profileId: string,
    mode: 'all' | 'matches',
    page: number,
  ): Promise<void> {
    const profile = await this.supabase.client
      .from('job_agent_profiles')
      .select('*')
      .eq('id', profileId)
      .single();
    if (profile.error) throw profile.error;
    let query = filteredVacancies(this.supabase.client, profile.data.browse_filters);
    if (mode === 'matches') {
      const pref = await this.preference(profileId);
      if (!completePreference(pref)) {
        await this.whatsapp.sendJobButtons(
          waId,
          'Uyğun vakansiyalar üçün əvvəl iş profilinizi tamamlayın.',
          [{ id: 'job:seeker', title: '🔎 Profil yarat' }, MENU],
        );
        return;
      }
      query = matchingVacancies(this.supabase.client, pref);
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
    if (mode === 'all') {
      rows.push({
        id: 'job:filter:menu',
        title: '🔍 Filterlə',
        description: 'Axtarış kriteriyaları',
      });
      rows.push({
        id: 'job:filter:clear',
        title: '🧹 Filterləri təmizlə',
        description: 'Bütün aktiv elanları göstər',
      });
    }
    rows.push({ ...MENU, description: 'Əsas menyuya qayıt' });
    // WhatsApp list rows are hidden behind its picker. Show the current page in chat too.
    if (jobs.length) {
      await this.whatsapp.sendText(
        waId,
        jobs
          .slice(0, PAGE_SIZE)
          .map(
            (job) =>
              `#${job.id} — ${job.title.slice(0, 120)}\n🏢 ${(job.company_name ?? 'Şirkət').slice(0, 160)}\n📍 Ünvan: ${(job.location_name ?? '-').slice(0, 250)} • ${job.work_mode ?? '-'}${mapsLink(job) ? `\n🗺️ Xəritədə bax: ${mapsLink(job)}` : ''}\n💰 ${this.salary(job)}`,
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
        `Biznes: ${employer?.company_name ?? 'Daxil edilməyib'}`,
        `VÖEN: ${employer?.voen ?? 'Daxil edilməyib'}`,
        `Email: ${profile.contact_email ?? employer?.email ?? 'Daxil edilməyib'}`,
        `Biznes təsdiqi: ${employer?.registration_status ?? 'draft'}`,
      ].join('\n'),
    );
    await this.whatsapp.sendJobButtons(waId, 'Profilinizi idarə edin.', [
      { id: 'job:profile:delete', title: '🗑️ Profili sil' },
      MENU,
    ]);
  }
  private salary(job: Vacancy): string {
    return job.salary_min != null || job.salary_max != null
      ? `${job.salary_min ?? ''}${job.salary_min != null && job.salary_max != null ? '–' : ''}${job.salary_max ?? ''} ${job.salary_currency ?? 'AZN'}`
      : 'Maaş göstərilməyib';
  }
  private formatJob(job: Vacancy): string {
    return `#${job.id} — ${job.title.slice(0, 120)}\n🏢 ${(job.company_name ?? 'Şirkət').slice(0, 160)}\n📍 Ünvan: ${(job.location_name ?? '-').slice(0, 250)}${mapsLink(job) ? `\n🗺️ Xəritədə bax: ${mapsLink(job)}` : ''}\n💼 ${job.work_mode ?? '-'}\n💰 ${this.salary(job)}\n📝 ${(job.description ?? '-').slice(0, job.source_url ? 1200 : 1500)}\n☎️ ${(job.contact_phone ?? '-').slice(0, 25)}${job.contact_email ? `\n📧 ${job.contact_email.slice(0, 254)}` : ''}${job.source_url ? `\n🔗 Mənbə: ${(job.source ?? '').slice(0, 40)}\n${job.source_url.slice(0, 1000)}` : ''}${job.metadata?.requirements ? `\nTələblər: ${String(job.metadata.requirements).slice(0, 250)}` : ''}`;
  }
  private filterLike(value: string): string {
    // Quoted PostgREST values keep commas/parentheses in user input out of its grammar.
    return filterLike(value);
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
