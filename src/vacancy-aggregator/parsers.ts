import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { RawVacancy } from './types';
import { text } from './normalization';

const list = (value: any): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const scalar = (value: any): string =>
  typeof value === 'object' ? String(value?.['#text'] ?? '') : String(value ?? '');

// Only externally approved syndicated content. No feed URL is guessed here.
export function parseRss(payload: string): RawVacancy[] {
  if (
    payload.length > 1000000 ||
    /<!DOCTYPE|<!ENTITY/i.test(payload) ||
    XMLValidator.validate(payload) !== true
  )
    throw new Error('Invalid or unsafe XML feed');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(payload);
  const entries = parsed.rss?.channel?.item ?? parsed.feed?.entry;
  if (!parsed.rss && !parsed.feed) throw new Error('Unsupported feed format');
  return list(entries)
    .slice(0, 50)
    .map((item) => ({
      external_id: scalar(item.guid ?? item.id) || undefined,
      source_url: scalar(
        typeof item.link === 'object'
          ? list(item.link).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href']
          : item.link,
      ),
      title: text(scalar(item.title)),
      company: scalar(item.company),
      category: scalar(item.category?.['@_term'] ?? item.category),
      location: scalar(item.location),
      work_mode: scalar(item.work_mode),
      salary: scalar(item.salary),
      description: scalar(
        item['content:encoded'] ?? item.description ?? item.content ?? item.summary,
      ),
      requirements: scalar(item.requirements),
      published_at: scalar(item.pubDate ?? item.published ?? item.updated),
      expires_at: scalar(item.expires_at),
      closed: scalar(item.status).toLowerCase() === 'closed',
    }));
}

// Standard schema.org parser; not a claim that either site currently emits this format.
export function parseJobPosting(payload: string): RawVacancy[] {
  if (payload.length > 1000000) throw new Error('Page too large');
  const jobs: any[] = [];
  const visit = (value: any, depth = 0): void => {
    if (!value || depth > 8 || jobs.length >= 50) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if (list(value['@type']).includes('JobPosting')) jobs.push(value);
    if (value['@graph']) visit(value['@graph'], depth + 1);
    if (value.itemListElement)
      list(value.itemListElement).forEach((v) => visit(v.item ?? v, depth + 1));
  };
  for (const match of payload.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      throw new Error('Invalid JobPosting JSON');
    }
  }
  if (!jobs.length) throw new Error('No supported JobPosting data');
  return jobs.map((job) => {
    const pay = job.baseSalary?.value;
    const address = list(job.jobLocation)[0]?.address;
    const country = address?.addressCountry;
    if (country && !['AZ', 'AZERBAIJAN', 'AZƏRBAYCAN'].includes(String(country).toUpperCase()))
      throw new Error('Non-Azerbaijan vacancy');
    return {
      external_id: scalar(job.identifier?.value ?? job.identifier) || undefined,
      source_url: scalar(job.url ?? job['@id']),
      title: scalar(job.title),
      company: scalar(job.hiringOrganization?.name),
      category: scalar(job.occupationalCategory?.name ?? job.occupationalCategory),
      location: text([address?.addressLocality, address?.streetAddress].filter(Boolean).join(', ')),
      work_mode: job.jobLocationType === 'TELECOMMUTE' ? 'remote' : scalar(job.workMode),
      salary_min: typeof pay === 'number' ? pay : (pay?.minValue ?? pay?.value),
      salary_max: typeof pay === 'number' ? pay : (pay?.maxValue ?? pay?.value),
      currency: job.baseSalary?.currency,
      salary_unit: pay?.unitText,
      description: scalar(job.description),
      requirements: scalar(job.qualifications ?? job.responsibilities),
      skills: Array.isArray(job.skills)
        ? job.skills
        : scalar(job.skills).split(/[,;]/).filter(Boolean),
      published_at: scalar(job.datePosted),
      expires_at: scalar(job.validThrough),
    };
  });
}
