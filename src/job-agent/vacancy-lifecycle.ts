import { validCoordinates, validEmail, validPhone } from './vacancy-validation';
export const RETENTION_MS = 28 * 24 * 60 * 60 * 1000;
export function retentionDeadline(job: any): number {
  return job.delete_at
    ? Date.parse(job.delete_at)
    : (job.created_at ? Date.parse(job.created_at) : Date.now()) + RETENTION_MS;
}
export function parsePublicationTime(
  value: string,
  deadline: number,
  now = Date.now(),
): string | undefined {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [day, month, year, hour, minute] = m.slice(1).map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute),
    d = new Date(local);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  )
    return undefined;
  const time = local - 4 * 60 * 60 * 1000;
  return time > now && time < deadline ? new Date(time).toISOString() : undefined;
}
export const EDIT_FIELDS = {
  title: 'Vəzifə',
  company_name: 'Biznes adı',
  description: 'Açıqlama',
  location_name: 'Şəhər / ünvan',
  work_mode: 'İş rejimi',
  salary: 'Maaş',
  contact_phone: 'Əlaqə nömrəsi',
  contact_email: 'Email',
  category_id: 'Kateqoriya',
  location_pin: 'Xəritə lokasiyası',
  scheduled_at: 'Yayım vaxtı',
};
export function editValue(
  field: string,
  text: string,
  job: any,
): Record<string, unknown> | undefined {
  const limits: Record<string, number> = {
    title: 120,
    company_name: 160,
    description: 1500,
    location_name: 250,
  };
  if (limits[field])
    return text.trim().length && text.length <= limits[field]
      ? { [field]: text.trim() }
      : undefined;
  if (field === 'work_mode')
    return ['office', 'remote', 'hybrid'].includes(text) ? { work_mode: text } : undefined;
  if (field === 'contact_phone') return validPhone(text) ? { contact_phone: text } : undefined;
  if (field === 'contact_email')
    return validEmail(text) ? { contact_email: text.toLowerCase() } : undefined;
  if (field === 'salary') {
    const m = /^(\d+(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d+(?:[.,]\d{1,2})?))?$/.exec(text);
    if (!m) return undefined;
    const min = Number(m[1].replace(',', '.')),
      max = m[2] ? Number(m[2].replace(',', '.')) : min;
    return min <= max && max <= 1000000 ? { salary_min: min, salary_max: max } : undefined;
  }
  if (field === 'scheduled_at') {
    const time = parsePublicationTime(text, retentionDeadline(job));
    return time ? { scheduled_at: time } : undefined;
  }
  return undefined;
}
export function validEditedJob(job: any): boolean {
  return Boolean(
    job.title?.trim() && (!['office', 'hybrid'].includes(job.work_mode) || validCoordinates(job)),
  );
}
export function publicationLabel(job: any): string {
  return job.scheduled_at
    ? `📅 Planlı yayım: ${new Date(job.scheduled_at).toLocaleString('az-AZ', { timeZone: 'Asia/Baku' })} (Bakı)`
    : job.status === 'active'
      ? '📢 Aktiv yayımlanır'
      : '📢 Təsdiqdən sonra dərhal yayım';
}
