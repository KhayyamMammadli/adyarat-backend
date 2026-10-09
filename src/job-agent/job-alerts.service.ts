import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
const HOME = { id: 'job:menu', title: 'Vakansiyalara qayıt' };
@Injectable()
export class JobAlertsService {
  constructor(
    private readonly db: SupabaseService,
    private readonly wa: WhatsAppClientService,
  ) {}
  private async state(p: any, state: string, d: any) {
    const r = await this.db.client
      .from('job_agent_profiles')
      .update({ state, browse_filters: { alert: d } })
      .eq('id', p.id);
    if (r.error) throw r.error;
  }
  private async owned(p: any, id: number) {
    const r = await this.db.client
      .from('job_alert_subscriptions')
      .select('*')
      .eq('id', id)
      .eq('profile_id', p.id)
      .maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }
  async interactive(p: any, action: string): Promise<boolean> {
    if (action === 'job:alerts') {
      await this.list(p);
      return true;
    }
    if (action === 'job:alerts:new') {
      const existing = await this.db.client
        .from('job_alert_subscriptions')
        .select('id')
        .eq('profile_id', p.id);
      if (existing.error) throw existing.error;
      if ((existing.data?.length ?? 0) >= 10) {
        await this.wa.sendText(p.wa_id, '10 seçiminiz var. Yeni seçim üçün birini silin.');
        await this.list(p);
        return true;
      }
      const d = {
        token: randomBytes(6).toString('hex'),
        salary_min: 0,
        location_name: null,
        work_modes: [],
      };
      await this.state(p, 'alert_edit', d);
      await this.categories(p, d, 0);
      return true;
    }
    const open = /^job:alerts:open:(\d+)$/.exec(action);
    if (open) {
      const a = await this.owned(p, Number(open[1]));
      if (!a) {
        await this.wa.sendText(p.wa_id, 'Seçim tapılmadı.');
        return true;
      }
      const category = await this.db.client
        .from('job_categories')
        .select('name')
        .eq('id', a.category_id)
        .maybeSingle();
      if (category.error) throw category.error;
      const d = { ...a, category_name: category.data?.name, token: randomBytes(6).toString('hex') };
      await this.state(p, 'alert_edit', d);
      await this.menu(p, d);
      return true;
    }
    const d = p.browse_filters?.alert;
    if (!action.startsWith('job:alert:')) return false;
    if (!d || !p.state.startsWith('alert_') || !action.startsWith(`job:alert:${d.token}:`))
      return true;
    const choice = action.split(':').at(-1)!;
    if (choice === 'category') {
      await this.categories(p, d, 0);
      return true;
    }
    if (choice.startsWith('page_')) {
      await this.categories(p, d, Number(choice.slice(5)));
      return true;
    }
    if (choice.startsWith('cat_')) {
      const r = await this.db.client
        .from('job_categories')
        .select('id,name')
        .eq('id', Number(choice.slice(4)))
        .eq('is_active', true)
        .maybeSingle();
      if (r.error) throw r.error;
      if (r.data) {
        d.category_id = r.data.id;
        d.category_name = r.data.name;
        await this.state(p, 'alert_edit', d);
        await this.menu(p, d);
      }
      return true;
    }
    if (choice === 'city') {
      await this.state(p, 'alert_city', d);
      await this.wa.sendJobList(
        p.wa_id,
        'Şəhəri seçin.',
        ['Bakı', 'Sumqayıt', 'Gəncə', 'Abşeron', 'Hamısı', 'Başqa şəhər']
          .map((title, i) => ({ id: `job:alert:${d.token}:city_${i}`, title }))
          .concat([HOME]),
      );
      return true;
    }
    if (choice.startsWith('city_') && p.state === 'alert_city') {
      const n = Number(choice.slice(5));
      if (n === 5) {
        await this.state(p, 'alert_city_text', d);
        await this.wa.sendText(p.wa_id, 'Şəhər/rayon adını yazın.');
        return true;
      }
      if (n < 0 || n > 4) return true;
      d.location_name = ['Bakı', 'Sumqayıt', 'Gəncə', 'Abşeron', null][n];
      await this.state(p, 'alert_edit', d);
      await this.menu(p, d);
      return true;
    }
    if (choice === 'salary') {
      await this.state(p, 'alert_salary', d);
      await this.wa.sendJobList(
        p.wa_id,
        'Minimum maaşı seçin (AZN).',
        [0, 500, 800, 1000, 1500, 2000]
          .map((n) => ({
            id: `job:alert:${d.token}:salary_${n}`,
            title: n ? `${n} AZN` : 'Maaş fərq etmir',
          }))
          .concat([{ id: `job:alert:${d.token}:salary_other`, title: 'Başqa məbləğ' }, HOME]),
      );
      return true;
    }
    if (choice.startsWith('salary_') && p.state === 'alert_salary') {
      if (choice === 'salary_other') {
        await this.state(p, 'alert_salary_text', d);
        await this.wa.sendText(p.wa_id, 'Minimum maaşı AZN ilə rəqəmlə yazın.');
        return true;
      }
      const n = Number(choice.slice(7));
      if (![0, 500, 800, 1000, 1500, 2000].includes(n)) return true;
      d.salary_min = n;
      await this.state(p, 'alert_edit', d);
      await this.menu(p, d);
      return true;
    }
    if (choice === 'mode') {
      await this.state(p, 'alert_mode', d);
      await this.wa.sendJobList(p.wa_id, 'İş rejimini seçin.', [
        { id: `job:alert:${d.token}:mode_any`, title: 'Hamısı' },
        ...['office', 'remote', 'hybrid'].map((m, i) => ({
          id: `job:alert:${d.token}:mode_${m}`,
          title: ['Ofis', 'Remote', 'Hibrid'][i],
        })),
        HOME,
      ]);
      return true;
    }
    if (choice.startsWith('mode_') && p.state === 'alert_mode') {
      const m = choice.slice(5);
      if (!['any', 'office', 'remote', 'hybrid'].includes(m)) return true;
      d.work_modes = m === 'any' ? [] : [m];
      await this.state(p, 'alert_edit', d);
      await this.menu(p, d);
      return true;
    }
    if (choice === 'delete' && d.id) {
      await this.state(p, 'alert_delete', d);
      await this.wa.sendJobButtons(p.wa_id, 'Bu bildiriş seçimini silməyə əminsiniz?', [
        { id: `job:alert:${d.token}:yes_delete`, title: 'Bəli, sil' },
        { id: `job:alert:${d.token}:no_delete`, title: 'Xeyr' },
      ]);
      return true;
    }
    if (choice === 'no_delete' && p.state === 'alert_delete') {
      await this.state(p, 'alert_edit', d);
      await this.menu(p, d);
      return true;
    }
    if (choice === 'yes_delete' && p.state === 'alert_delete') {
      const r = await this.db.client
        .from('job_alert_subscriptions')
        .delete()
        .eq('id', d.id)
        .eq('profile_id', p.id)
        .eq('revision', d.revision)
        .select('id')
        .maybeSingle();
      if (r.error) throw r.error;
      await this.wa.sendText(
        p.wa_id,
        r.data ? '✅ Bildiriş seçiminiz silindi.' : 'Seçim dəyişib və ya artıq silinib.',
      );
      await this.list(p);
      return true;
    }
    if (choice === 'save' && p.state === 'alert_edit' && d.category_id) {
      await this.state(p, 'alert_confirm', d);
      await this.wa.sendJobButtons(
        p.wa_id,
        `${this.summary(d)}\nUyğun YENİ vakansiyalar üçün bu nömrəyə WhatsApp bildirişləri göndərilməsinə razısınız? İstənilən vaxt seçimləri silə və bildirişləri dayandıra bilərsiniz.`,
        [{ id: `job:alert:${d.token}:consent`, title: 'Razıyam, saxla' }, HOME],
      );
      return true;
    }
    if (choice === 'consent' && p.state === 'alert_confirm') {
      const values = {
        category_id: d.category_id,
        location_name: d.location_name,
        salary_min: d.salary_min,
        work_modes: d.work_modes,
        consent_at: new Date().toISOString(),
      };
      const q = d.id
        ? this.db.client
            .from('job_alert_subscriptions')
            .update(values)
            .eq('id', d.id)
            .eq('profile_id', p.id)
            .eq('revision', d.revision)
        : this.db.client.from('job_alert_subscriptions').insert({ ...values, profile_id: p.id });
      const r = await q.select('id').maybeSingle();
      if (r.error) throw r.error;
      await this.wa.sendText(
        p.wa_id,
        r.data
          ? '✅ Bildiriş seçimi saxlanıldı. Uyğun yeni elanların bildirişlərinə abunə oldunuz.'
          : 'Seçim dəyişib. Yenidən açın.',
      );
      await this.list(p);
      return true;
    }
    return true;
  }
  async text(p: any, text: string): Promise<boolean> {
    if (!p.state.startsWith('alert_')) return false;
    const d = p.browse_filters?.alert;
    if (!d) return true;
    if (p.state === 'alert_city_text' && text.trim().length > 0 && text.trim().length <= 250)
      d.location_name = text.trim();
    else if (
      p.state === 'alert_salary_text' &&
      /^\d+(?:[.,]\d{1,2})?$/.test(text) &&
      Number(text.replace(',', '.')) <= 1000000
    )
      d.salary_min = Number(text.replace(',', '.'));
    else {
      await this.wa.sendText(
        p.wa_id,
        'Düymələrdən seçim edin və ya cari sahəyə uyğun məlumat yazın.',
      );
      return true;
    }
    await this.state(p, 'alert_edit', d);
    await this.menu(p, d);
    return true;
  }
  private summary(d: any) {
    return `🔔 ${d.category_name ?? `Kateqoriya #${d.category_id ?? '-'}`}\n📍 ${d.location_name ?? 'Bütün şəhərlər'}\n💰 ${d.salary_min ? `${d.salary_min}+ AZN` : 'Maaş fərq etmir'}\n💼 ${d.work_modes?.join(', ') || 'Bütün iş rejimləri'}`;
  }
  private async menu(p: any, d: any) {
    await this.wa.sendJobList(
      p.wa_id,
      this.summary(d),
      ['category', 'city', 'salary', 'mode', 'save', ...(d.id ? ['delete'] : [])]
        .map((k, i) => ({
          id: `job:alert:${d.token}:${k}`,
          title: ['Kateqoriya', 'Şəhər', 'Minimum maaş', 'İş rejimi', 'Saxla', 'Seçimi sil'][i],
        }))
        .concat([HOME]),
    );
  }
  private async categories(p: any, d: any, page: number) {
    if (!Number.isInteger(page) || page < 0 || page > 100) return;
    const r = await this.db.client
      .from('job_categories')
      .select('id,name')
      .eq('is_active', true)
      .order('id')
      .range(page * 6, page * 6 + 6);
    if (r.error) throw r.error;
    const rows = (r.data ?? []).slice(0, 6).map((c) => ({
      id: `job:alert:${d.token}:cat_${c.id}`,
      title: String(c.name).slice(0, 24),
      description: String(c.name).slice(0, 72),
    }));
    if (page)
      rows.push({ id: `job:alert:${d.token}:page_${page - 1}`, title: 'Geri', description: '' });
    if ((r.data?.length ?? 0) > 6)
      rows.push({ id: `job:alert:${d.token}:page_${page + 1}`, title: 'Növbəti', description: '' });
    rows.push({ ...HOME, description: '' });
    await this.wa.sendJobList(p.wa_id, 'Bildiriş üçün kateqoriya seçin.', rows);
  }
  private async list(p: any) {
    const r = await this.db.client
      .from('job_alert_subscriptions')
      .select('*')
      .eq('profile_id', p.id)
      .order('id');
    if (r.error) throw r.error;
    const categories = await this.db.client.from('job_categories').select('id,name');
    if (categories.error) throw categories.error;
    const names = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
    const rows = (r.data ?? []).map((a) => ({
      id: `job:alerts:open:${a.id}`,
      title: String(names.get(a.category_id) ?? 'Kateqoriya').slice(0, 24),
      description:
        `${a.salary_min ? `${a.salary_min}+ AZN` : 'Maaş fərq etmir'} • ${a.location_name ?? 'Bütün şəhərlər'}`.slice(
          0,
          72,
        ),
    }));
    // Split ten stored alerts over two pickers to preserve the WhatsApp 10-row limit.
    await this.state(p, 'browse_all', undefined);
    if (rows.length > 8)
      await this.wa.sendJobList(p.wa_id, 'Digər bildiriş seçimləriniz.', rows.slice(8));
    await this.wa.sendJobList(
      p.wa_id,
      '🔔 Bildirişlərim — seçimi açıb redaktə və ya silə bilərsiniz.',
      rows.slice(0, 8).concat([
        {
          id: 'job:alerts:new',
          title: 'Yeni seçim yarat',
          description: 'Kateqoriya, maaş və yer seçin',
        },
        { ...HOME, description: '' },
      ]),
    );
  }
}
