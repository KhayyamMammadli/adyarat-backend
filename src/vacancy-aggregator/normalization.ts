import { bounded } from './http';
import { createHash } from 'node:crypto';
import { RawVacancy, NormalizedVacancy, SemanticNormalizationProvider } from './types';

export const text = (value: unknown, max = 12000): string =>
  String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || value.length > 1500)
    throw new Error('Invalid source URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.toString().length > 1000) throw new Error('Source URL too long');
  return url.toString();
}

function date(value?: string): string | null {
  // Accept ISO or feed dates only; never guess locale day/month order.
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)|^[A-Za-z]{3},/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
export function workMode(value: string): NormalizedVacancy['work_mode'] {
  const lower = value.toLocaleLowerCase('az');
  if (/hybrid|hibrid/.test(lower)) return 'hybrid';
  if (/remote|uzaqdan|distant|telecommute/.test(lower)) return 'remote';
  if (/office|ofis|on.?site/.test(lower)) return 'office';
  return null; // FULL_TIME is employment type, not proof of office work.
}

export function salary(raw: RawVacancy): [number | null, number | null, string] {
  const currency = /USD|\$/i.test(raw.salary ?? '')
    ? 'USD'
    : /EUR|€/i.test(raw.salary ?? '')
      ? 'EUR'
      : (raw.currency ?? 'AZN').toUpperCase();
  if (!['AZN', 'USD', 'EUR'].includes(currency)) throw new Error('Unsupported currency');
  if (raw.salary_unit && !/^(MONTH|MONTHLY)$/i.test(raw.salary_unit)) return [null, null, currency];
  let min = raw.salary_min,
    max = raw.salary_max;
  if (min == null && max == null && raw.salary) {
    const input = raw.salary.replace(/(AZN|USD|EUR|₼|\$|€|manat)/gi, '').trim();
    const match = /^(\d+(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d+(?:[.,]\d{1,2})?))?$/.exec(input);
    if (match) {
      min = Number(match[1].replace(',', '.'));
      max = Number((match[2] ?? match[1]).replace(',', '.'));
    }
  }
  for (const n of [min, max])
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1000000))
      throw new Error('Invalid salary');
  if (min != null && max != null && min > max) throw new Error('Invalid salary range');
  return [min ?? null, max ?? null, currency];
}

export class VacancyNormalizer {
  constructor(
    private readonly provider?: SemanticNormalizationProvider,
    private readonly providerTimeoutMs = 3000,
  ) {}
  async normalize(
    source: string,
    input: RawVacancy,
    signal: AbortSignal,
  ): Promise<NormalizedVacancy> {
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(source)) throw new Error('Invalid source');
    const raw = { ...input };
    const description = text(raw.description);
    const deterministicSkills = [
      'React',
      'Next.js',
      'TypeScript',
      'JavaScript',
      'Python',
      'SQL',
      'Excel',
      'Git',
    ].filter((skill) =>
      `${raw.title} ${description} ${raw.requirements ?? ''}`
        .toLowerCase()
        .includes(skill.toLowerCase()),
    );
    let mode = workMode(`${raw.work_mode ?? ''} ${description}`);
    if (
      this.provider &&
      (!raw.category || !mode || (!raw.skills?.length && !deterministicSkills.length))
    ) {
      try {
        const enrichment = await bounded(
          (local) => this.provider!.enrich(raw, AbortSignal.any([signal, local])),
          this.providerTimeoutMs,
        );
        if (typeof enrichment.category === 'string') raw.category ||= enrichment.category;
        if (typeof enrichment.requirements === 'string')
          raw.requirements ||= enrichment.requirements;
        if (!raw.skills?.length && !deterministicSkills.length)
          raw.skills = Array.isArray(enrichment.skills)
            ? enrichment.skills.filter((v) => typeof v === 'string')
            : [];
        mode ||= workMode(typeof enrichment.work_mode === 'string' ? enrichment.work_mode : '');
      } catch {
        /* Optional AI outage never blocks deterministic import. */
      }
    }
    const title = text(raw.title, 120);
    if (!title) throw new Error('Missing vacancy title');
    const url = canonicalUrl(raw.source_url);
    const externalId =
      (String(raw.external_id ?? '').length > 200
        ? `id:${createHash('sha256').update(String(raw.external_id)).digest('hex')}`
        : text(raw.external_id, 200)) || `url:${createHash('sha256').update(url).digest('hex')}`;
    const [min, max, currency] = salary(raw);
    const company = text(raw.company, 160) || null;
    const location = text(raw.location, 250) || null;
    const fingerprint = createHash('sha256')
      .update([title, company, location].join('|').toLocaleLowerCase('az'))
      .digest('hex');
    const skills = [
      ...new Set(
        [...(Array.isArray(raw.skills) ? raw.skills : []), ...deterministicSkills]
          .map((skill) => text(skill, 60).toLocaleLowerCase('az'))
          .filter(Boolean),
      ),
    ].slice(0, 30);
    const publishedAt = date(raw.published_at);
    // Unknown expiry is bounded, not an evergreen external vacancy.
    const expiresAt =
      date(raw.expires_at) ??
      new Date(
        new Date(publishedAt ?? new Date().toISOString()).getTime() + 30 * 86400000,
      ).toISOString();
    return {
      source,
      source_url: url,
      external_id: externalId,
      title,
      company,
      location,
      category: text(raw.category, 120) || null,
      work_mode: mode,
      salary_min: min,
      salary_max: max,
      currency,
      description,
      requirements: text(raw.requirements),
      skills,
      published_at: publishedAt,
      expires_at: expiresAt,
      collected_at: new Date().toISOString(),
      status:
        raw.closed || (expiresAt && expiresAt <= new Date().toISOString()) ? 'closed' : 'pending',
      fingerprint,
    };
  }
}
