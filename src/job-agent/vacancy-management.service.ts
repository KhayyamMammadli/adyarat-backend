import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { TelegramAdminService } from '../telegram/telegram.service';
import { formatTelegramJob, moderationButtons } from '../telegram/job-message';
import { EDIT_FIELDS, editValue, validEditedJob, publicationLabel } from './vacancy-lifecycle';
import { validCoordinates } from './vacancy-validation';
const HOME = { id: 'job:menu', title: 'Əsas menyu' };
@Injectable()
export class VacancyManagementService {
  constructor(
    private readonly db: SupabaseService,
    private readonly wa: WhatsAppClientService,
    private readonly telegram: TelegramAdminService,
  ) {}
  private async state(p: any, state: string, management?: any) {
    const r = await this.db.client
      .from('job_agent_profiles')
      .update({ state, browse_filters: management ? { management } : {} })
      .eq('id', p.id);
    if (r.error) throw r.error;
  }
  private async owned(p: any, id: number) {
    const r = await this.db.client
      .from('jobs')
      .select('*')
      .eq('id', id)
      .contains('metadata', { employer_profile_id: p.id })
      .maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }
  async interactive(p: any, action: string): Promise<boolean> {
    if (action === 'job:profile:delete') {
      const token = randomBytes(6).toString('hex');
      await this.state(p, 'profile_delete_confirm', { token });
      await this.wa.sendJobButtons(
        p.wa_id,
        'Profiliniz və qeydiyyat məlumatları silinəcək. Öz elanlarınız bağlanacaq, planlı yayımlar ləğv olunacaq. Təsdiqləyirsiniz?',
        [{ id: `job:profile:delete:${token}`, title: '🗑️ Profili sil' }, HOME],
      );
      return true;
    }
    if (action.startsWith('job:profile:delete:')) {
      if (
        p.state !== 'profile_delete_confirm' ||
        action !== `job:profile:delete:${p.browse_filters?.management?.token}`
      )
        return true;
      const r = await this.db.client.rpc('delete_own_job_profile', {
        p_profile: p.id,
        p_wa_id: p.wa_id,
      });
      if (r.error) throw r.error;
      await this.wa.sendText(
        p.wa_id,
        r.data ? '✅ Profil silindi. Yenidən qeydiyyatdan keçə bilərsiniz.' : 'Profil silinmədi.',
      );
      await this.wa.sendJobMainMenu(p.wa_id);
      return true;
    }
    const page = /^job:mine(?::(\d{1,6}))?$/.exec(action);
    if (page && p.role === 'employer') {
      const index = Number(page[1] ?? 0);
      const r = await this.db.client
        .from('jobs')
        .select('*')
        .contains('metadata', { employer_profile_id: p.id })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(index * 5, index * 5 + 5);
      if (r.error) throw r.error;
      const rows = (r.data ?? []).slice(0, 5).map((j) => ({
        id: `job:edit:${j.id}`,
        title: String(j.title).slice(0, 24),
        description: `#${j.id} • ${j.status}`,
      }));
      if (index) rows.push({ id: `job:mine:${index - 1}`, title: '⬅️ Geri', description: '' });
      if ((r.data?.length ?? 0) > 5)
        rows.push({ id: `job:mine:${index + 1}`, title: 'Növbəti ➡️', description: '' });
      rows.push({ ...HOME, description: '' });
      await this.state(p, 'job_manage_list');
      await this.wa.sendJobList(p.wa_id, '📋 Öz elanlarınız. Redaktə üçün seçin.', rows);
      return true;
    }
    const edit = /^job:edit:(\d+)$/.exec(action);
    if (edit && p.role === 'employer') {
      const j = await this.owned(p, Number(edit[1]));
      if (!j) {
        await this.wa.sendText(p.wa_id, 'Elan tapılmadı.');
        return true;
      }
      const m = {
        jobId: j.id,
        revision: j.revision ?? 1,
        draft: j,
        patch: {},
        token: randomBytes(6).toString('hex'),
      };
      await this.state(p, 'job_edit_menu', m);
      await this.menu(p, m);
      return true;
    }
    if (!action.startsWith('job:manage:')) return false;
    const m = p.browse_filters?.management;
    if (
      p.role !== 'employer' ||
      !m ||
      !p.state.startsWith('job_edit') ||
      !action.startsWith(`job:manage:${m.token}:`)
    )
      return true;
    const choice = action.split(':').at(-1)!;
    if (choice === 'delete') {
      await this.state(p, 'job_edit_delete_confirm', m);
      await this.wa.sendJobButtons(
        p.wa_id,
        `⚠️ #${m.jobId} — ${String(m.draft.title).slice(0, 120)}\nElanı silməyə əminsiniz? Bu əməliyyatı geri qaytarmaq mümkün olmayacaq.`,
        [
          { id: `job:manage:${m.token}:confirm_delete`, title: 'Bəli, sil' },
          { id: `job:manage:${m.token}:cancel_delete`, title: 'Xeyr, saxla' },
        ],
      );
      return true;
    }
    if (choice === 'cancel_delete') {
      if (p.state !== 'job_edit_delete_confirm') return true;
      await this.state(p, 'job_edit_menu', m);
      await this.wa.sendText(p.wa_id, 'Silmə ləğv edildi. Elanınız saxlanıldı.');
      await this.menu(p, m, true);
      return true;
    }
    if (choice === 'confirm_delete') {
      if (p.state !== 'job_edit_delete_confirm') return true;
      const current = await this.owned(p, m.jobId);
      if (!current || Number(current.revision ?? 1) !== Number(m.revision)) {
        await this.state(p, 'ready');
        await this.wa.sendText(p.wa_id, 'Elan tapılmadı və ya dəyişib. Silinmədi; siyahını yeniləyin.');
        await this.wa.sendJobMainMenu(p.wa_id, undefined, 'employer');
        return true;
      }
      const deleted = await this.db.client
        .from('jobs')
        .delete()
        .eq('id', m.jobId)
        .contains('metadata', { employer_profile_id: p.id })
        .eq('revision', m.revision)
        .select('id')
        .maybeSingle();
      if (deleted.error) throw deleted.error;
      await this.state(p, 'ready');
      await this.wa.sendText(
        p.wa_id,
        deleted.data ? '✅ Elanınız uğurla silindi.' : 'Elan artıq mövcud deyil və ya dəyişib. Silinmədi.',
      );
      await this.wa.sendJobMainMenu(p.wa_id, undefined, 'employer');
      return true;
    }
    if (choice === 'more' || choice === 'back') {
      await this.menu(p, m, choice === 'more');
      return true;
    }
    if (choice === 'save') {
      if (!Object.keys(m.patch).length) {
        await this.wa.sendText(p.wa_id, 'Hələ dəyişiklik etməmisiniz.');
        return true;
      }
      if (!validEditedJob(m.draft)) {
        await this.wa.sendText(
          p.wa_id,
          'Ofis/Hibrid elan üçün dəqiq xəritə lokasiyası tələb olunur.',
        );
        await this.menu(p, m, true);
        return true;
      }
      const r = await this.db.client.rpc('save_vacancy_revision', {
        p_job: m.jobId,
        p_profile: p.id,
        p_telegram_user: null,
        p_revision: m.revision,
        p_patch: m.patch,
      });
      if (r.error) throw r.error;
      if (!r.data) {
        await this.wa.sendText(
          p.wa_id,
          'Elan dəyişib, vaxtı bitib və ya biznes təsdiqi yoxdur. Elanı yenidən açın.',
        );
        return true;
      }
      await this.state(p, 'ready');
      await this.telegram.sendMessage(
        `✏️ Yenilənmiş vakansiya\n${formatTelegramJob(r.data)}`,
        moderationButtons(r.data.id, r.data.revision),
      );
      await this.wa.sendText(
        p.wa_id,
        '✅ Düzəliş moderasiyaya göndərildi. Yeni təsdiqədək elan yayımlanmır.',
      );
      await this.wa.sendJobMainMenu(p.wa_id, undefined, 'employer');
      return true;
    }
    if (choice === 'skip' || choice === 'now') {
      if (
        (choice === 'now' && m.field !== 'scheduled_at') ||
        (choice === 'skip' && !['contact_phone', 'contact_email', 'salary'].includes(m.field))
      )
        return true;
      const patch =
        choice === 'now'
          ? { scheduled_at: null }
          : m.field === 'contact_phone'
            ? { contact_phone: null }
            : m.field === 'contact_email'
              ? { contact_email: null }
              : { salary_min: null, salary_max: null };
      await this.changed(p, m, patch);
      return true;
    }
    if (['office', 'remote', 'hybrid'].includes(choice) && m.field === 'work_mode') {
      await this.changed(p, m, { work_mode: choice });
      return true;
    }
    if (choice.startsWith('cat_')) {
      const id = Number(choice.slice(4));
      const r = await this.db.client
        .from('job_categories')
        .select('id')
        .eq('id', id)
        .eq('is_active', true)
        .maybeSingle();
      if (r.error) throw r.error;
      if (r.data) await this.changed(p, m, { category_id: id });
      return true;
    }
    if (choice.startsWith('cats_')) {
      await this.categories(p, m, Number(choice.slice(5)));
      return true;
    }
    if (!(choice in EDIT_FIELDS)) return true;
    m.field = choice;
    await this.state(p, choice === 'location_pin' ? 'job_edit_pin' : 'job_edit_value', m);
    if (choice === 'work_mode') {
      await this.wa.sendJobButtons(
        p.wa_id,
        'İş rejimini seçin.',
        ['office', 'remote', 'hybrid'].map((mode) => ({
          id: `job:manage:${m.token}:${mode}`,
          title: mode === 'office' ? 'Ofis' : mode === 'remote' ? 'Remote' : 'Hybrid',
        })),
      );
    } else if (choice === 'category_id') await this.categories(p, m, 0);
    else if (choice === 'location_pin')
      await this.wa.sendJobButtons(p.wa_id, '📎 → Location ilə dəqiq məkan göndərin.', [HOME]);
    else
      await this.wa.sendJobButtons(
        p.wa_id,
        choice === 'scheduled_at'
          ? 'Bakı vaxtı ilə gələcək tarix yazın: DD.MM.YYYY HH:mm. Tarix elanın 28 günlük son müddətindən əvvəl olmalıdır.'
          : `${EDIT_FIELDS[choice as keyof typeof EDIT_FIELDS]} üçün yeni məlumat yazın.`,
        [
          ...(['salary', 'contact_phone', 'contact_email'].includes(choice)
            ? [{ id: `job:manage:${m.token}:skip`, title: '⏭️ Boş saxla' }]
            : choice === 'scheduled_at'
              ? [{ id: `job:manage:${m.token}:now`, title: 'Dərhal yayımla' }]
              : []),
          HOME,
        ],
      );
    return true;
  }
  private async categories(p: any, m: any, page: number) {
    const r = await this.db.client
      .from('job_categories')
      .select('id,name')
      .eq('is_active', true)
      .order('id')
      .range(page * 6, page * 6 + 6);
    if (r.error) throw r.error;
    const rows = (r.data ?? []).slice(0, 6).map((c) => ({
      id: `job:manage:${m.token}:cat_${c.id}`,
      title: String(c.name).slice(0, 24),
      description: String(c.name).slice(0, 72),
    }));
    if (page)
      rows.push({
        id: `job:manage:${m.token}:cats_${page - 1}`,
        title: '⬅️ Geri',
        description: '',
      });
    if ((r.data?.length ?? 0) > 6)
      rows.push({
        id: `job:manage:${m.token}:cats_${page + 1}`,
        title: 'Növbəti ➡️',
        description: '',
      });
    rows.push({ ...HOME, description: '' });
    await this.wa.sendJobList(p.wa_id, 'Kateqoriyanı seçin.', rows);
  }
  private async changed(p: any, m: any, patch: any) {
    m.patch = { ...m.patch, ...patch };
    m.draft = { ...m.draft, ...patch };
    await this.state(p, 'job_edit_menu', m);
    await this.menu(p, m);
  }
  async text(p: any, text: string): Promise<boolean> {
    if (p.state !== 'job_edit_value') return false;
    const m = p.browse_filters?.management;
    if (!m) return true;
    const patch = editValue(m.field, text, m.draft);
    if (!patch) {
      await this.wa.sendText(p.wa_id, 'Məlumat düzgün deyil. Cari sahəyə uyğun cavab yazın.');
      return true;
    }
    await this.changed(p, m, patch);
    return true;
  }
  async location(p: any, location: any): Promise<boolean> {
    if (p.state !== 'job_edit_pin') return false;
    if (!validCoordinates(location)) {
      await this.wa.sendText(p.wa_id, 'Düzgün lokasiya göndərin.');
      return true;
    }
    const patch: any = { latitude: location.latitude, longitude: location.longitude };
    if (location.address || location.name)
      patch.location_name = String(location.address || location.name).slice(0, 250);
    await this.changed(p, p.browse_filters.management, patch);
    return true;
  }
  private async menu(p: any, m: any, more = false) {
    const fields = more
      ? ['category_id', 'location_pin', 'scheduled_at']
      : Object.keys(EDIT_FIELDS).slice(0, 8);
    const rows = fields.map((field) => ({
      id: `job:manage:${m.token}:${field}`,
      title: EDIT_FIELDS[field as keyof typeof EDIT_FIELDS],
    }));
    if (!more)
      rows.push({ id: `job:manage:${m.token}:more`, title: 'Digər sahələr / Saxla' }, HOME);
    else
      rows.push(
        { id: `job:manage:${m.token}:save`, title: '💾 Düzəlişi göndər' },
        { id: `job:manage:${m.token}:delete`, title: '🗑️ Elanı sil' },
        { id: `job:manage:${m.token}:back`, title: 'Sahələrə qayıt' },
        HOME,
      );
    await this.wa.sendJobList(
      p.wa_id,
      `✏️ #${m.jobId} — ${String(m.draft.title).slice(0, 120)}\n${publicationLabel(m.draft)}\nDəyişikliklər yalnız Saxla basıldıqda tətbiq edilir.`,
      rows,
    );
  }
}
