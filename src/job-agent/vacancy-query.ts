import { SupabaseClient } from '@supabase/supabase-js';

export const literalLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
export const filterLike = (value: string): string => JSON.stringify(`%${literalLike(value)}%`);
export function completePreference(pref: any): boolean {
  return Boolean(
    pref &&
    (pref.desired_title || pref.category_id) &&
    pref.location_name &&
    pref.salary_min != null &&
    Number.isFinite(Number(pref.salary_min)),
  );
}
export function activeVacancies(client: SupabaseClient) {
  return client
    .from('jobs')
    .select('*')
    .eq('status', 'active')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
}
// One source of query rules for WhatsApp browsing and future notification planning.
export function matchingVacancies(client: SupabaseClient, pref: any) {
  if (!completePreference(pref)) throw new Error('Incomplete seeker preferences');
  let query = activeVacancies(client);
  if (pref.category_id && pref.desired_title) {
    query = query.or(
      `category_id.eq.${Number(pref.category_id)},title.ilike.${filterLike(pref.desired_title)}`,
    );
  } else if (pref.category_id) query = query.eq('category_id', pref.category_id);
  else query = query.ilike('title', `%${literalLike(pref.desired_title)}%`);
  const city = pref.location_name.trim();
  const cities = /^(bakı|baki|baku)$/i.test(city) ? ['Bakı', 'Baki', 'Baku'] : [city];
  query = query.or(
    [
      'work_mode.eq.remote',
      ...cities.map((name) => `location_name.ilike.${filterLike(name)}`),
    ].join(','),
  );
  if (pref.work_modes?.length) query = query.in('work_mode', pref.work_modes);
  query = query
    .eq('salary_currency', pref.salary_currency ?? 'AZN')
    .or(
      `salary_max.gte.${Number(pref.salary_min)},and(salary_max.is.null,salary_min.gte.${Number(pref.salary_min)})`,
    );
  const skills = Array.isArray(pref.metadata?.skills)
    ? pref.metadata.skills
        .filter((v: unknown): v is string => typeof v === 'string')
        .map((v: string) => v.trim().toLocaleLowerCase('az'))
        .filter(Boolean)
        .slice(0, 30)
    : [];
  if (skills.length) query = query.contains('metadata', { skills });
  return query;
}
