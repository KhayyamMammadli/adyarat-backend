import { JobAgentService } from '../../dist/job-agent/job-agent.service.js';
import { JobAdminService } from '../../dist/job-agent/job-admin.service.js';

// Stateful query fixture: preserves partial upserts like PostgREST and evaluates
// status/ownership/search filters, ranges and conditional moderation updates.
export function fixture() {
  const tables = {
    job_agent_profiles: [],
    job_seeker_preferences: [],
    employer_profiles: [],
    jobs: [],
  };
  const calls = [];
  const sent = [];
  const notices = [];
  let failure;
  const client = {
    from(table) {
      const spec = { table, op: 'read', filters: [], orders: [], ors: [] };
      calls.push(spec);
      const q = {
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
        eq(k, v) {
          spec.filters.push((row) => (k === 'salary_currency' ? (row[k] ?? 'AZN') : row[k]) === v);
          return q;
        },
        contains(k, v) {
          spec.filters.push((row) =>
            Object.entries(v).every(
              ([key, value]) => JSON.stringify(row[k]?.[key]) === JSON.stringify(value),
            ),
          );
          return q;
        },
        ilike(k, v) {
          const needle = v
            .slice(1, -1)
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
          } else if (value.startsWith('work_mode.eq.remote')) {
            const cities = [...value.matchAll(/location_name.ilike.("(?:[^"\\]|\\.)*")/g)].map(
              (m) => JSON.parse(m[1]).slice(1, -1).toLowerCase(),
            );
            spec.filters.push(
              (row) =>
                row.work_mode === 'remote' ||
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
        order(k, opts) {
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
              let rows = tables[table];
              if (spec.op === 'upsert' || spec.op === 'insert') {
                const keys = (
                  spec.options?.onConflict ??
                  (table === 'job_agent_profiles' ? 'wa_id' : 'profile_id')
                ).split(',');
                let row =
                  spec.op === 'upsert'
                    ? rows.find((r) => keys.every((key) => r[key] === spec.value[key]))
                    : undefined;
                if (row && spec.options?.ignoreDuplicates) return { data: null, error: null };
                if (row) Object.assign(row, spec.value);
                else {
                  row = {
                    ...(table === 'job_agent_profiles'
                      ? { id: `p${rows.length + 1}`, state: 'welcome' }
                      : table === 'jobs'
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
    ['sendText', 'sendJobButtons', 'sendJobList', 'sendJobMainMenu', 'markAsRead'].map((name) => [
      name,
      async (...args) => {
        sent.push({ name, args });
        return 'message';
      },
    ]),
  );
  const noticeButtons = [];
  const telegram = {
    sendMessage: async (text, markup) => {
      notices.push(text);
      noticeButtons.push(markup);
    },
  };
  const service = new JobAgentService({ client }, whatsapp, telegram);
  return {
    service,
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
  await f.action('job:employer');
  for (const text of [
    'Yelo',
    'Frontend developer',
    'Bakı, Nizami 1',
    '1',
    '1000',
    '2000',
    'React təcrübəsi',
    '+994501234567',
  ])
    await f.text(text);
  return f.tables.jobs[0];
}
export async function seeker(f) {
  await f.action('job:seeker');
  for (const text of ['Frontend', 'Bakı', '1', '1000']) await f.text(text);
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
