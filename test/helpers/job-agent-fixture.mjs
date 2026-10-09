import {
  BusinessRegistrationService,
  normalizePhone,
} from '../../dist/job-agent/business-registration.service.js';
import { JobAlertsService } from '../../dist/job-agent/job-alerts.service.js';
import { JobAgentService } from '../../dist/job-agent/job-agent.service.js';
import { distanceKm } from '../../dist/job-agent/vacancy-validation.js';
import { JobAdminService } from '../../dist/job-agent/job-admin.service.js';

// Stateful query fixture: preserves partial upserts like PostgREST and evaluates
// status/ownership/search filters, ranges and conditional moderation updates.
export function fixture() {
  const tables = {
    job_agent_profiles: [],
    job_seeker_preferences: [],
    employer_profiles: [],
    jobs: [],
    vacancy_browse_events: [],
    job_alert_subscriptions: [],
    job_categories: [],
    vacancy_notification_intents: [],
  };
  const calls = [];
  const sent = [];
  const notices = [];
  let failure;
  const client = {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (path) => ({
          data: { signedUrl: `https://fixture.invalid/${path}` },
          error: null,
        }),
      }),
    },
    rpc(name, args) {
      if (name === 'claim_job_profile_contact') {
        const p = tables.job_agent_profiles.find((p) => p.id === args.p_profile_id);
        const email = args.p_email?.toLowerCase(),
          phone = normalizePhone(args.p_phone ?? '');
        if (
          tables.job_agent_profiles.some(
            (other) =>
              other.id !== p.id &&
              ((email && other.contact_email === email) ||
                (phone &&
                  (normalizePhone(other.contact_phone ?? '') === phone ||
                    normalizePhone(other.phone ?? '') === phone))),
          ) ||
          tables.employer_profiles.some(
            (e) => e.profile_id !== p.id && email && e.email?.toLowerCase() === email,
          )
        )
          return Promise.resolve({ error: { code: '23505' } });
        if (email) p.contact_email = email;
        if (phone) p.contact_phone = phone;
        return Promise.resolve({ error: null });
      }
      if (name !== 'jobs_within_radius') throw new Error('Unexpected RPC');
      return client.from('jobs').radius(args);
    },
    from(table) {
      const spec = { table, op: 'read', filters: [], orders: [], ors: [] };
      calls.push(spec);
      const q = {
        radius(args) {
          spec.filters.push(
            (row) =>
              (args.include_remote && row.work_mode === 'remote') ||
              distanceKm({ latitude: args.center_lat, longitude: args.center_lon }, row) <=
                args.max_km,
          );
          return q;
        },
        select() {
          return q;
        },
        upsert(value, options = {}) {
          spec.options = options;
          spec.op = 'upsert';
          spec.value = value;
          return q;
        },
        insert(value) {
          spec.op = 'insert';
          spec.value = value;
          return q;
        },
        update(value) {
          spec.op = 'update';
          spec.value = value;
          return q;
        },
        delete() {
          spec.op = 'delete';
          return q;
        },
        match(value) {
          for (const [k, v] of Object.entries(value)) q.eq(k, v);
          return q;
        },
        eq(k, v) {
          spec.filters.push((row) => (k === 'salary_currency' ? (row[k] ?? 'AZN') : row[k]) === v);
          return q;
        },
        contains(k, v) {
          spec.filters.push((row) =>
            Object.entries(v).every(([key, value]) =>
              Array.isArray(value)
                ? value.every((v) => row[k]?.[key]?.includes(v))
                : JSON.stringify(row[k]?.[key]) === JSON.stringify(value),
            ),
          );
          return q;
        },
        ilike(k, v) {
          const needle = (v.startsWith('%') && v.endsWith('%') ? v.slice(1, -1) : v)
            .replace(/\\([%_\\])/g, '$1')
            .toLowerCase();
          spec.filters.push((row) =>
            String(row[k] ?? '')
              .toLowerCase()
              .includes(needle),
          );
          return q;
        },
        in(k, values) {
          spec.filters.push((row) => values.includes(row[k]));
          return q;
        },
        or(value) {
          spec.ors.push(value);
          if (value.startsWith('category_id')) {
            const category = Number(/category_id.eq.(\d+)/.exec(value)[1]);
            const title = JSON.parse(value.slice(value.indexOf('title.ilike.') + 12)).slice(1, -1);
            spec.filters.push(
              (row) =>
                row.category_id === category ||
                String(row.title).toLowerCase().includes(title.toLowerCase()),
            );
          } else if (
            value.startsWith('work_mode.eq.remote') ||
            value.startsWith('location_name.ilike.')
          ) {
            const cities = [...value.matchAll(/location_name.ilike.("(?:[^"\\]|\\.)*")/g)].map(
              (m) => JSON.parse(m[1]).slice(1, -1).toLowerCase(),
            );
            spec.filters.push(
              (row) =>
                (value.startsWith('work_mode.eq.remote') && row.work_mode === 'remote') ||
                cities.some((city) =>
                  String(row.location_name ?? '')
                    .toLowerCase()
                    .includes(city),
                ),
            );
          } else if (value.startsWith('expires_at'))
            spec.filters.push(
              (row) => !row.expires_at || row.expires_at > new Date().toISOString(),
            );
          else {
            const min = Number(/gte\.(\d+)/.exec(value)[1]);
            spec.filters.push((row) =>
              row.salary_max != null
                ? row.salary_max >= min
                : row.salary_min != null && row.salary_min >= min,
            );
          }
          return q;
        },
        order(k, opts = { ascending: true }) {
          spec.orders.push([k, opts.ascending]);
          return q;
        },
        range(from, to) {
          spec.range = [from, to];
          return q;
        },
        limit(n) {
          spec.range = [0, n - 1];
          return q;
        },
        single() {
          spec.single = true;
          return q;
        },
        maybeSingle() {
          spec.maybeSingle = true;
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              if (failure?.table === table && (!failure.op || failure.op === spec.op)) {
                const error = failure.error;
                failure = undefined;
                return { data: null, error };
              }
              const allRows = tables[table];
              let rows = allRows;
              if (spec.op === 'upsert' || spec.op === 'insert') {
                const keys = (
                  spec.options?.onConflict ??
                  (table === 'job_agent_profiles' ? 'wa_id' : 'profile_id')
                ).split(',');
                let row =
                  spec.op === 'upsert'
                    ? rows.find((r) => keys.every((key) => r[key] === spec.value[key]))
                    : undefined;
                if (
                  !row &&
                  table === 'jobs' &&
                  spec.value.source_url &&
                  rows.some(
                    (r) => r.source === spec.value.source && r.source_url === spec.value.source_url,
                  )
                )
                  return { data: null, error: { code: '23505' } };
                if (row && spec.options?.ignoreDuplicates) return { data: null, error: null };
                if (row) Object.assign(row, spec.value);
                else {
                  row = {
                    ...(table === 'job_agent_profiles'
                      ? { id: `p${rows.length + 1}`, state: 'welcome' }
                      : table === 'jobs' || table === 'job_alert_subscriptions'
                        ? { id: rows.length + 1, created_at: new Date().toISOString() }
                        : {}),
                    ...spec.value,
                  };
                  rows.push(row);
                }
                rows = [row];
              } else {
                rows = rows.filter((row) => spec.filters.every((filter) => filter(row)));
                if (spec.op === 'update') rows.forEach((row) => Object.assign(row, spec.value));
                if (spec.op === 'delete')
                  tables[table] = allRows.filter((row) => !rows.includes(row));
              }
              for (const [key, asc] of [...spec.orders].reverse())
                rows.sort((a, b) =>
                  a[key] === b[key] ? 0 : (a[key] > b[key] ? 1 : -1) * (asc ? 1 : -1),
                );
              if (spec.range) rows = rows.slice(spec.range[0], spec.range[1] + 1);
              if (spec.single && rows.length !== 1)
                return { data: null, error: new Error('Expected one row') };
              return {
                data: structuredClone(spec.single || spec.maybeSingle ? (rows[0] ?? null) : rows),
                error: null,
              };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
  };
  const whatsapp = Object.fromEntries(
    [
      'sendJobLocation',
      'sendText',
      'sendJobButtons',
      'sendJobList',
      'sendJobMainMenu',
      'markAsRead',
    ].map((name) => [
      name,
      async (...args) => {
        sent.push({ name, args });
        return 'message';
      },
    ]),
  );
  whatsapp.downloadMedia = async () => ({
    bytes: Buffer.from([255, 216, 255, 224]),
    mimeType: 'image/jpeg',
    fileSize: 4,
  });
  const noticeButtons = [];
  const telegram = {
    sendMessage: async (text, markup) => {
      notices.push(text);
      noticeButtons.push(markup);
    },
  };
  telegram.sendPhoto = async (url, text, markup) => {
    notices.push(text);
    noticeButtons.push(markup);
  };
  telegram.sendTo = async () => ({ message_id: 1 });
  const registry = {
    lookup: async (voen) => ({
      status: 'found',
      voen,
      legalName: 'Fixture business',
      reference: 'fixture-lookup-only',
    }),
  };
  const businesses = new BusinessRegistrationService({ client }, whatsapp, telegram, registry);
  const service = new JobAgentService(
    { client },
    whatsapp,
    telegram,
    businesses,
    undefined,
    new JobAlertsService({ client }, whatsapp),
  );
  return {
    service,
    businesses,
    registry,
    tables,
    sent,
    calls,
    notices,
    whatsapp,
    client,
    noticeButtons,
    admin: new JobAdminService({ client }, whatsapp),
    fail: (table, error, op) => {
      failure = { table, error, op };
    },
    action: (id) => service.handleInteractive('wa1', id, 'Xeyyam'),
    text: (text) => service.handleText('wa1', text, 'Xeyyam'),
    state: () => tables.job_agent_profiles[0]?.state,
  };
}
export async function employerDraft(f) {
  await approvedEmployer(f, 'Yelo');
  await f.action('job:employer:new');
  for (const text of ['Frontend developer', 'Bakı, Nizami 1', '1']) await f.text(text);
  await f.service.handleLocation('wa1', { latitude: 40.4093, longitude: 49.8671 });
  for (const text of ['1000', '2000', 'React təcrübəsi']) await f.text(text);
  await f.action('job:contact:add');
  await f.text('+994501234567');
  return f.tables.jobs[0];
}
export async function seeker(f) {
  await f.action('job:seeker');
  for (const text of ['Frontend', 'Bakı', '1', '1000']) await f.text(text);
  if (f.state() === 'seeker_email') await f.text('hr@example.com');
  if (f.state() === 'seeker_phone') await f.text('+994501234567');
}
export const last = (f, name) => f.sent.filter((call) => call.name === name).at(-1);
export function seedJobs(f, n = 12) {
  f.tables.jobs.push(
    ...Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      title: `Frontend ${i + 1}`,
      company_name: 'Yelo',
      location_name: 'Bakı',
      work_mode: 'office',
      salary_min: 1000,
      salary_max: 2000,
      status: 'active',
      description: 'React',
      contact_phone: '+994501234567',
      created_at: '2026-01-01',
    })),
  );
}

export async function approvedEmployer(f, name = 'Company') {
  await f.action('job:employer');
  if (f.state() === 'business_type') await f.action('job:business:type:company');
  if (f.state() === 'employer_company') await f.text(name);
  if (f.state() === 'employer_voen') await f.text('1500315641');
  if (f.state() === 'business_photo') await f.service.handleImage('wa1', { id: 'photo' });
  for (const [state, text] of [
    ['business_contact_name', 'Owner'],
    ['business_description', 'Business'],
    ['business_address', 'Bakı'],
    ['employer_email', 'hr@example.com'],
    ['business_phone', '+994501234567'],
  ])
    if (f.state() === state) await f.text(text);
  if (f.state() === 'business_confirm') await f.action('job:business:submit');
  const e = f.tables.employer_profiles[0];
  if (e.registration_status === 'pending')
    await f.businesses.moderate(e.profile_id, e.registration_token, true, 7);
  await f.action('job:employer');
}
