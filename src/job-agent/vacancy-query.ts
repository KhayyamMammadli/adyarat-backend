import { validCoordinates } from './vacancy-validation';
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
export function activeVacancies(client: SupabaseClient, criteria?: any, includeRemote = false) {
  const radius = criteria?.radius_km;
  // Both table and set-returning RPC use the same untyped canonical jobs row.
  const base: any =
    validCoordinates(criteria) && Number.isFinite(radius) && radius > 0 && radius <= 200
      ? client.rpc('jobs_within_radius', {
          center_lat: criteria.latitude,
          center_lon: criteria.longitude,
          max_km: radius,
          include_remote: includeRemote,
        })
      : client.from('jobs');
  return base
    .select('*')
    .eq('status', 'active')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
}
// One source of query rules for WhatsApp browsing and future notification planning.
export function matchingVacancies(client: SupabaseClient, pref: any) {
  if (!completePreference(pref)) throw new Error('Incomplete seeker preferences');
  let query = activeVacancies(client, pref, true);
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

export function filteredVacancies(client: SupabaseClient, filters: any = {}) {
  let query = activeVacancies(client, filters);
  if (filters.title) query = query.ilike('title', `%${literalLike(filters.title)}%`);
  if (filters.category_id) query = query.eq('category_id', filters.category_id);
  if (filters.location_name) {
    const cities = /^(bakı|baki|baku)$/i.test(filters.location_name)
      ? ['Bakı', 'Baki', 'Baku']
      : [filters.location_name];
    query = query.or(cities.map((name) => `location_name.ilike.${filterLike(name)}`).join(','));
  }
  if (filters.work_mode) query = query.eq('work_mode', filters.work_mode);
  if (filters.salary_min != null)
    query = query
      .eq('salary_currency', 'AZN')
      .or(
        `salary_max.gte.${filters.salary_min},and(salary_max.is.null,salary_min.gte.${filters.salary_min})`,
      );
  return query;
}
