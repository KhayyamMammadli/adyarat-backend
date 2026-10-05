import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { TelegramAdminService } from '../telegram/telegram.service';
import { TaxpayerRegistryService } from './taxpayer-registry.service';
import { validEmail, validPhone, validVoen } from './vacancy-validation';

const MENU = { id: 'job:menu', title: 'Əsas menyu' };
const BUCKET = 'job-business-photos';
export const BUSINESS_TYPES: Record<string, string> = {
  company: 'Şirkət',
  doner: 'Dönərxana',
  kebab: 'Kababxana',
  restaurant: 'Restoran',
  cafe: 'Kafe',
  shop: 'Mağaza',
  service: 'Xidmət',
  other: 'Digər biznes',
};
export function normalizePhone(raw: string): string | undefined {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) digits = `994${digits.slice(1)}`;
  return validPhone(raw) && /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : undefined;
}
export function photoMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  return undefined;
}
export function voenEvidence(e: any): boolean {
  return Boolean(
    e?.voen_verified_at &&
    e?.registry_reference &&
    e?.legal_name &&
    (e?.voen_verification_method === 'registry' ||
      (e?.voen_verification_method === 'admin_manual' && e?.voen_verified_by)),
  );
}
export function businessComplete(e: any, p: any, requireEvidence = true): boolean {
  return Boolean(
    BUSINESS_TYPES[e?.business_type] &&
    e?.company_name?.trim() &&
    validVoen(e?.voen) &&
    (!requireEvidence || voenEvidence(e)) &&
    e?.photo_path &&
    e?.contact_name &&
    e?.business_description &&
    e?.business_address &&
    validEmail(p?.contact_email) &&
    normalizePhone(p?.contact_phone ?? ''),
  );
}
export function businessButtons(e: any) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Təsdiq et', callback_data: `biz:a:${e.profile_id}:${e.registration_token}` },
        { text: '❌ Rədd et', callback_data: `biz:r:${e.profile_id}:${e.registration_token}` },
      ],
    ],
  };
}

@Injectable()
export class BusinessRegistrationService {
  private readonly logger = new Logger(BusinessRegistrationService.name);
  constructor(
    private readonly supabase: SupabaseService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly telegram: TelegramAdminService,
    private readonly registry: TaxpayerRegistryService,
  ) {}

  async employer(id: string): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('employer_profiles')
      .select('*')
      .eq('profile_id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  private async profile(id: string): Promise<any> {
    const { data, error } = await this.supabase.client
      .from('job_agent_profiles')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  }
  private async save(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase.client
      .from('employer_profiles')
      .upsert(
        { profile_id: id, ...patch, updated_at: new Date().toISOString() },
        { onConflict: 'profile_id' },
      );
    if (error) throw error;
  }
  private async state(id: string, state: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('job_agent_profiles')
      .update({ state })
      .eq('id', id);
    if (error) throw error;
  }
  private async prompt(waId: string, text: string): Promise<void> {
    await this.whatsapp.sendJobButtons(waId, text, [MENU]);
  }
  async isApproved(id: string): Promise<boolean> {
    const [e, p] = await Promise.all([this.employer(id), this.profile(id)]);
    return e?.registration_status === 'approved' && e.verified === true && businessComplete(e, p);
  }
  async restart(waId: string, id: string): Promise<void> {
    await this.save(id, {
      verified: false,
      registration_status: 'draft',
      registration_token: null,
      rejection_reason: null,
      business_type: null,
      company_name: null,
      voen: null,
      voen_verified_at: null,
      voen_verification_method: null,
      voen_verified_by: null,
      registry_reference: null,
      legal_name: null,
      photo_path: null,
      contact_name: null,
      business_description: null,
      business_address: null,
      metadata: {
        ...(await this.employer(id))?.metadata,
        draft_job_id: null,
        onboarding_return: null,
      },
    });
    await this.require(waId, id);
  }
  async require(waId: string, id: string): Promise<void> {
    const [e, p] = await Promise.all([this.employer(id), this.profile(id)]);
    if (e?.registration_status === 'pending') {
      await this.state(id, 'employer_pending');
      await this.prompt(
        waId,
        '⏳ Biznes profiliniz admin təsdiqini gözləyir. Təsdiqədək vakansiya yarada bilməzsiniz.',
      );
      return;
    }
    if (e?.registration_status === 'rejected') {
      await this.state(id, 'employer_rejected');
      await this.whatsapp.sendJobButtons(
        waId,
        `❌ Biznes profiliniz rədd edilib.\nSəbəb: ${e.rejection_reason ?? '-'}\nMəlumatları düzəldib yenidən göndərə bilərsiniz.`,
        [{ id: 'job:business:edit', title: '✏️ Profili düzəlt' }, MENU],
      );
      return;
    }
    if (e?.registration_status === 'approved' && e.verified && businessComplete(e, p)) {
      await this.state(id, 'employer_ready');
      await this.whatsapp.sendJobButtons(
        waId,
        `✅ Biznes profiliniz təsdiqlənib.\n${BUSINESS_TYPES[e.business_type]}: ${e.company_name}\nVÖEN: ${e.voen}\nVakansiya paylaşa bilərsiniz.`,
        [
          { id: 'job:employer:new', title: 'Vakansiya əlavə et' },
          { id: 'job:employer:edit', title: '✏️ Profili düzəlt' },
          MENU,
        ],
      );
      return;
    }
    const step = !BUSINESS_TYPES[e?.business_type]
      ? 'business_type'
      : !e?.company_name?.trim()
        ? 'employer_company'
        : !validVoen(e?.voen) ||
            (!voenEvidence(e) && e?.voen_verification_method !== 'pending_admin')
          ? 'employer_voen'
          : !e?.photo_path
            ? 'business_photo'
            : !e?.contact_name
              ? 'business_contact_name'
              : !e?.business_description
                ? 'business_description'
                : !e?.business_address
                  ? 'business_address'
                  : !validEmail(p.contact_email)
                    ? 'employer_email'
                    : !normalizePhone(p.contact_phone ?? '')
                      ? 'business_phone'
                      : 'business_confirm';
    await this.state(id, step);
    if (step === 'business_type') {
      await this.whatsapp.sendJobList(
        waId,
        '🏢 Biznesinizin növünü seçin.',
        Object.entries(BUSINESS_TYPES)
          .map(([id, title]) => ({ id: `job:business:type:${id}`, title }))
          .concat([MENU]),
      );
      return;
    }
    if (step === 'business_confirm') {
      await this.whatsapp.sendText(waId, await this.summary(e, p));
      await this.whatsapp.sendJobButtons(
        waId,
        'Profil məlumatlarını yoxlayın. Təsdiqdən sonra Telegram admininə göndəriləcək.',
        [
          { id: 'job:business:submit', title: '✅ Təsdiq et' },
          { id: 'job:business:edit', title: '✏️ Profili düzəlt' },
          MENU,
        ],
      );
      return;
    }
    const questions: Record<string, string> = {
      employer_company: '🏢 Biznesin / müəssisənin adını yazın.',
      employer_voen:
        '10 rəqəmli VÖEN-i yazın. Rəsmi avtomatik yoxlama əlçatan olmadıqda admin onu ayrıca yoxlayacaq.',
      business_photo:
        '🖼️ Biznes profilinin şəklini WhatsApp-da şəkil kimi göndərin (JPEG/PNG, maksimum 5 MB).',
      business_contact_name: '👤 Əlaqədar şəxsin adını yazın.',
      business_description: '📝 Biznesiniz haqqında qısa məlumat yazın.',
      business_address: '📍 Biznesin şəhərini və ünvanını yazın.',
      employer_email: '📧 Profil email ünvanını yazın. Başqa istifadəçinin email-i qəbul edilmir.',
      business_phone:
        '📱 Profil telefon nömrəsini yazın. Başqa istifadəçinin nömrəsi qəbul edilmir.',
    };
    await this.prompt(waId, questions[step]);
  }
  async interactive(p: any, action: string): Promise<boolean> {
    if (p.role !== 'employer') return false;
    const type = /^job:business:type:(\w+)$/.exec(action);
    if (type && p.state === 'business_type' && BUSINESS_TYPES[type[1]]) {
      await this.save(p.id, {
        business_type: type[1],
        registration_status: 'draft',
        verified: false,
      });
      await this.require(p.wa_id, p.id);
      return true;
    }
    if (
      (action === 'job:business:edit' || action === 'job:employer:edit') &&
      ['business_confirm', 'employer_ready', 'employer_rejected'].includes(p.state)
    ) {
      await this.restart(p.wa_id, p.id);
      return true;
    }
    if (action === 'job:business:submit' && p.state === 'business_confirm') {
      const e = await this.employer(p.id),
        current = await this.profile(p.id);
      if (!businessComplete(e, current, false)) {
        await this.require(p.wa_id, p.id);
        return true;
      }
      const token = randomBytes(6).toString('hex');
      const { data, error } = await this.supabase.client
        .from('employer_profiles')
        .update({
          registration_status: 'pending',
          verified: false,
          registration_token: token,
          rejection_reason: null,
        })
        .eq('profile_id', p.id)
        .eq('registration_status', 'draft')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (data) await this.notify(data, current);
      await this.require(p.wa_id, p.id);
      return true;
    }
    return false;
  }
  async text(p: any, raw: string): Promise<boolean> {
    if (p.role !== 'employer') return false;
    const fields: Record<string, [string, number]> = {
      employer_company: ['company_name', 160],
      business_contact_name: ['contact_name', 120],
      business_description: ['business_description', 1000],
      business_address: ['business_address', 250],
    };
    if (fields[p.state]) {
      const [field, max] = fields[p.state];
      if (!raw.trim() || raw.length > max) {
        await this.prompt(p.wa_id, `Cavab 1–${max} simvol olmalıdır.`);
        return true;
      }
      await this.save(p.id, { [field]: raw.trim(), registration_status: 'draft', verified: false });
    } else if (p.state === 'employer_voen') {
      if (!validVoen(raw)) {
        await this.prompt(p.wa_id, 'VÖEN 10 rəqəmdən ibarət olmalıdır.');
        return true;
      }
      let result;
      try {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            this.registry.lookup(raw, controller.signal),
            new Promise<{ status: 'unavailable' }>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve({ status: 'unavailable' });
              }, 8000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch {
        result = { status: 'unavailable' as const };
      }
      if (!result || result.status === 'unavailable') {
        await this.save(p.id, {
          voen: raw,
          voen_verified_at: null,
          voen_verified_by: null,
          voen_verification_method: 'pending_admin',
          registry_reference: null,
          legal_name: null,
          registration_status: 'draft',
          verified: false,
        });
        await this.prompt(
          p.wa_id,
          'ℹ️ Avtomatik VÖEN yoxlaması əlçatan deyil. Qeydiyyatı davam edə bilərsiniz; VÖEN admin tərəfindən rəsmi bazada yoxlanmadan vakansiya paylaşa bilməzsiniz.',
        );
        await this.require(p.wa_id, p.id);
        return true;
      }
      if (
        result.status !== 'found' ||
        result.voen !== raw ||
        typeof result.legalName !== 'string' ||
        !result.legalName.trim() ||
        typeof result.reference !== 'string' ||
        !result.reference.trim()
      ) {
        await this.prompt(p.wa_id, '❌ Bu VÖEN rəsmi bazada təsdiqlənmədi. Düzgün VÖEN yazın.');
        return true;
      }
      await this.save(p.id, {
        voen: raw,
        legal_name: result.legalName.slice(0, 250),
        voen_verification_method: 'registry',
        voen_verified_by: null,
        registry_reference: result.reference.slice(0, 500),
        voen_verified_at: new Date().toISOString(),
        registration_status: 'draft',
        verified: false,
      });
    } else if (p.state === 'employer_email') {
      if (!(await this.claimContact(p, 'email', raw))) return true;
      await this.save(p.id, { email: raw.trim().toLowerCase() });
    } else if (p.state === 'business_phone') {
      if (!(await this.claimContact(p, 'phone', raw))) return true;
    } else if (
      [
        'business_type',
        'business_photo',
        'business_confirm',
        'employer_pending',
        'employer_rejected',
      ].includes(p.state)
    ) {
      await this.require(p.wa_id, p.id);
      return true;
    } else return false;
    await this.require(p.wa_id, p.id);
    return true;
  }
  async claimContact(p: any, kind: 'email' | 'phone', raw: string): Promise<boolean> {
    const value = kind === 'email' ? raw.trim().toLowerCase() : normalizePhone(raw);
    if (!value || (kind === 'email' && !validEmail(value))) {
      await this.prompt(
        p.wa_id,
        kind === 'email'
          ? 'Düzgün email yazın.'
          : 'Düzgün telefon nömrəsi yazın. Məsələn: +994501234567',
      );
      return false;
    }
    const { error } = await this.supabase.client.rpc('claim_job_profile_contact', {
      p_profile_id: p.id,
      p_email: kind === 'email' ? value : null,
      p_phone: kind === 'phone' ? value : null,
    });
    if (error) {
      if (error.code === '23505') {
        await this.prompt(
          p.wa_id,
          'Bu email və ya telefon başqa istifadəçinin profilində mövcuddur. Başqa əlaqə məlumatı yazın.',
        );
        return false;
      }
      throw error;
    }
    return true;
  }
  async seekerContact(p: any): Promise<void> {
    const current = await this.profile(p.id);
    const step = !validEmail(current.contact_email)
      ? 'seeker_email'
      : !normalizePhone(current.contact_phone ?? '')
        ? 'seeker_phone'
        : 'ready';
    await this.state(p.id, step);
    if (step === 'ready') {
      await this.whatsapp.sendText(p.wa_id, '✅ İş profiliniz saxlanıldı.');
      await this.whatsapp.sendJobMainMenu(p.wa_id);
    } else
      await this.prompt(
        p.wa_id,
        step === 'seeker_email'
          ? '📧 Profil email ünvanını yazın.'
          : '📱 Profil telefon nömrəsini yazın.',
      );
  }
  async image(p: any, mediaId: string): Promise<void> {
    if (p.role !== 'employer' || p.state !== 'business_photo') {
      await this.prompt(p.wa_id, 'Şəkil cari addımda tələb olunmur.');
      return;
    }
    let media;
    try {
      media = await this.whatsapp.downloadMedia(mediaId, 5 * 1024 * 1024);
    } catch (error) {
      if (error instanceof Error && error.message.includes('size limit')) {
        await this.prompt(p.wa_id, 'Şəkil maksimum 5 MB olmalıdır.');
        return;
      }
      throw error;
    }
    const mime = photoMime(media.bytes);
    if (!mime || media.bytes.length > 5 * 1024 * 1024) {
      await this.prompt(p.wa_id, 'JPEG və ya PNG şəkli göndərin (maksimum 5 MB).');
      return;
    }
    const path = `${p.id}/${randomUUID()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .upload(path, media.bytes, { contentType: mime, upsert: false });
    if (error) throw error;
    await this.save(p.id, { photo_path: path });
    await this.require(p.wa_id, p.id);
  }
  private async summary(e: any, p: any): Promise<string> {
    return `🏢 ${BUSINESS_TYPES[e.business_type] ?? '-'}: ${e.company_name}\nVÖEN: ${e.voen}\nRəsmi ad: ${e.legal_name ?? 'Admin yoxlamasını gözləyir'}\nVÖEN yoxlaması: ${voenEvidence(e) ? e.voen_verification_method : 'YOXLANMAYIB — admin rəsmi bazada yoxlamalıdır'}\n👤 ${e.contact_name}\n📝 ${e.business_description}\n📍 ${e.business_address}\n📧 ${p.contact_email}\n📱 ${p.contact_phone}`;
  }
  async notify(e: any, p?: any, chatId?: number): Promise<void> {
    p ??= await this.profile(e.profile_id);
    const text = await this.summary(e, p),
      buttons = businessButtons(e);
    // Short-lived private URL; recovery panel generates a fresh URL every time.
    try {
      const { data, error } = await this.supabase.client.storage
        .from(BUCKET)
        .createSignedUrl(e.photo_path, 300);
      if (error || !data?.signedUrl) throw new Error('Photo URL unavailable');
      await this.telegram.sendPhoto(data.signedUrl, text.slice(0, 1000), buttons, chatId);
      if (text.length > 1000) {
        if (chatId) await this.telegram.sendTo(chatId, text);
        else await this.telegram.sendMessage(text);
      }
    } catch {
      this.logger.warn('Business profile photo notification failed; pending panel can recover it');
      if (chatId) await this.telegram.sendTo(chatId, text, buttons);
      else await this.telegram.sendMessage(text, buttons);
    }
  }
  async pending(chatId: number): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('employer_profiles')
      .select('*')
      .eq('registration_status', 'pending')
      .order('updated_at')
      .limit(10);
    if (error) throw error;
    await this.telegram.sendTo(
      chatId,
      data?.length
        ? '🏢 Təsdiq gözləyən biznes profilləri (ilk 10).'
        : 'Gözləyən biznes profili yoxdur.',
    );
    for (const e of data ?? []) await this.notify(e, undefined, chatId);
  }
  async verifyManually(
    id: string,
    token: string,
    legalName: string,
    adminId: number,
  ): Promise<boolean> {
    const e = await this.employer(id),
      p = await this.profile(id);
    if (
      e?.registration_status !== 'pending' ||
      e.registration_token !== token ||
      e.voen_verification_method !== 'pending_admin' ||
      !businessComplete(e, p, false) ||
      !legalName.trim() ||
      legalName.length > 250
    )
      return false;
    const { data, error } = await this.supabase.client
      .from('employer_profiles')
      .update({
        legal_name: legalName.trim(),
        voen_verified_at: new Date().toISOString(),
        voen_verified_by: String(adminId),
        voen_verification_method: 'admin_manual',
        registry_reference: 'https://new.e-taxes.gov.az/etaxes/services/taxpayer-info',
      })
      .eq('profile_id', id)
      .eq('registration_status', 'pending')
      .eq('registration_token', token)
      .eq('voen_verification_method', 'pending_admin')
      .select('profile_id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
  async moderate(id: string, token: string, approved: boolean, adminId: number): Promise<boolean> {
    const e = await this.employer(id),
      p = await this.profile(id);
    if (
      e?.registration_status !== 'pending' ||
      e.registration_token !== token ||
      !businessComplete(e, p, approved)
    )
      return false;
    const { data, error } = await this.supabase.client
      .from('employer_profiles')
      .update({
        registration_status: approved ? 'approved' : 'rejected',
        verified: approved,
        rejection_reason: approved
          ? null
          : 'Admin biznes profilini təsdiqləmədi. Məlumatları düzəldib yenidən göndərin.',
        reviewed_by: String(adminId),
        reviewed_at: new Date().toISOString(),
      })
      .eq('profile_id', id)
      .eq('registration_status', 'pending')
      .eq('registration_token', token)
      .select('profile_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    // Do not overwrite a seeker/filter/vacancy state with an asynchronous admin decision.
    try {
      await this.whatsapp.sendJobButtons(
        p.wa_id,
        approved
          ? '✅ Biznes profiliniz admin tərəfindən təsdiqləndi. Artıq vakansiya paylaşa bilərsiniz.'
          : '❌ Biznes profiliniz rədd edilib. Məlumatları düzəldib yenidən göndərin.',
        [{ id: 'job:employer', title: '🏢 Biznes profilim' }, MENU],
      );
    } catch {
      this.logger.warn('Business moderation WhatsApp notification failed; profile status is saved');
    }
    return true;
  }
}
