import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobAgentService } from '../dist/job-agent/job-agent.service.js';
import { JobAdminService } from '../dist/job-agent/job-admin.service.js';
import { JobAgentWebhookService } from '../dist/job-agent/job-agent-webhook.service.js';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
import { TelegramController } from '../dist/telegram/telegram.controller.js';
import { ConfigService } from '@nestjs/config';

// Stateful query fixture: preserves partial upserts like PostgREST and evaluates
// status/ownership/search filters, ranges and conditional moderation updates.
function fixture() {
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
        upsert(value) {
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
          spec.filters.push((row) => row[k] === v);
          return q;
        },
        contains(k, v) {
          spec.filters.push((row) =>
            Object.entries(v).every(([key, value]) => row[k]?.[key] === value),
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
          if (value.startsWith('expires_at'))
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
                const key = table === 'job_agent_profiles' ? 'wa_id' : 'profile_id';
                let row =
                  spec.op === 'upsert' ? rows.find((r) => r[key] === spec.value[key]) : undefined;
                if (row) Object.assign(row, spec.value);
                else {
                  row = {
                    ...(table === 'job_agent_profiles'
                      ? { id: 'p1', state: 'welcome' }
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
  const telegram = { sendMessage: async (text) => notices.push(text) };
  const service = new JobAgentService({ client }, whatsapp, telegram);
  return {
    service,
    tables,
    sent,
    calls,
    notices,
    whatsapp,
    admin: new JobAdminService({ client }, whatsapp),
    fail: (table, error, op) => {
      failure = { table, error, op };
    },
    action: (id) => service.handleInteractive('wa1', id, 'Xeyyam'),
    text: (text) => service.handleText('wa1', text, 'Xeyyam'),
    state: () => tables.job_agent_profiles[0]?.state,
  };
}
async function employerDraft(f) {
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
async function seeker(f) {
  await f.action('job:seeker');
  for (const text of ['Frontend', 'Bakı', '1', '1000']) await f.text(text);
}
const last = (f, name) => f.sent.filter((call) => call.name === name).at(-1);
function seedJobs(f, n = 12) {
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

test('first message and bare menu numbers only open interactive main menu', async () => {
  const f = fixture();
  for (const text of ['Salam', '1', '2', '3']) await f.text(text);
  assert.equal(f.tables.job_agent_profiles[0].role, undefined);
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.sent.filter((s) => s.name === 'sendJobMainMenu').length, 4);
});
test('seeker sequence persists preferences, including current-step numeric mode', async () => {
  const f = fixture();
  await seeker(f);
  assert.equal(f.state(), 'ready');
  assert.equal(f.tables.job_agent_profiles[0].role, 'seeker');
  assert.deepEqual(f.tables.job_seeker_preferences[0].work_modes, ['office']);
  assert.equal(f.tables.job_seeker_preferences[0].desired_title, 'Frontend');
  assert.equal(f.tables.job_seeker_preferences[0].location_name, 'Bakı');
  assert.equal(f.tables.job_seeker_preferences[0].salary_min, 1000);
});
test('salary rejects malformed or negative input and accepts zero', async () => {
  const f = fixture();
  await f.action('job:seeker');
  for (const text of ['Developer', 'Bakı', '2']) await f.text(text);
  for (const text of ['-100', 'abc100', '100-200', 'Infinity']) {
    await f.text(text);
    assert.equal(f.state(), 'seeker_salary');
  }
  await f.text('0');
  assert.equal(f.state(), 'ready');
  assert.equal(f.tables.job_seeker_preferences[0].salary_min, 0);
});
test('role actions interrupt active state and reset incomplete data/draft pointer', async () => {
  const f = fixture();
  await seeker(f);
  await f.action('job:employer');
  await f.text('Company');
  await f.text('Title');
  const draft = f.tables.jobs[0];
  await f.action('job:seeker');
  assert.equal(f.state(), 'seeker_category');
  assert.equal(f.tables.job_seeker_preferences[0].salary_min, null);
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_company');
  assert.equal(f.tables.employer_profiles[0].metadata.draft_job_id, null);
  assert.equal(draft.status, 'draft');
  assert.equal(f.tables.jobs.length, 1);
});
test('menu resets active state and old interactive replies cannot become text answers', async () => {
  const f = fixture();
  await f.action('job:employer');
  await f.action('job:mode:employer:office');
  assert.equal(f.state(), 'employer_company');
  assert.equal(f.tables.employer_profiles[0].company_name, undefined);
  await f.action('job:menu');
  assert.equal(f.state(), 'ready');
  await f.action('job:seeker');
  await f.action('menu_create_ad');
  assert.equal(f.state(), 'seeker_category');
  assert.equal(f.tables.jobs.length, 0);
});
test('numeric answers are current-step data, never global role shortcuts', async () => {
  const f = fixture();
  await f.action('job:employer');
  await f.text('1');
  assert.equal(f.tables.employer_profiles[0].company_name, '1');
  await f.text('2');
  assert.equal(f.tables.jobs[0].title, '2');
  await f.text('3');
  await f.text('2');
  assert.equal(f.tables.jobs[0].work_mode, 'remote');
  assert.equal(f.state(), 'employer_salary_min');
  assert.equal(f.tables.job_agent_profiles[0].role, 'employer');
});
test('employer flow keeps company, preview and contact in draft until explicit confirmation', async () => {
  const f = fixture();
  const job = await employerDraft(f);
  assert.equal(f.state(), 'employer_confirm');
  assert.equal(job.status, 'draft');
  assert.equal(job.company_name, 'Yelo');
  assert.equal(job.contact_phone, '+994501234567');
  await f.text('1');
  assert.equal(job.status, 'draft');
  await f.action('job:confirm:999');
  assert.equal(job.status, 'draft');
  await f.action(`job:confirm:${job.id}`);
  assert.equal(job.status, 'pending');
  assert.equal(f.state(), 'ready');
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /\/approve 1/);
  await f.action(`job:confirm:${job.id}`);
  assert.equal(f.notices.length, 1);
});
test('maximum salary and contact validation preserve current state', async () => {
  const f = fixture();
  await f.action('job:employer');
  for (const text of ['Company', 'Title', 'Bakı', '3', '1000']) await f.text(text);
  await f.text('900');
  assert.equal(f.state(), 'employer_salary_max');
  await f.text('1500');
  await f.text('Description');
  await f.text('x');
  assert.equal(f.state(), 'employer_contact');
});
test('database errors propagate and do not advance seeker state', async () => {
  const f = fixture();
  await f.action('job:seeker');
  f.fail('job_seeker_preferences', new Error('DB unavailable'));
  await assert.rejects(f.text('Developer'), /DB unavailable/);
  assert.equal(f.state(), 'seeker_category');
});
test('draft updates enforce ownership and draft status', async () => {
  const f = fixture();
  await f.action('job:employer');
  await f.text('Company');
  await f.text('Title');
  f.tables.jobs[0].metadata.employer_profile_id = 'other';
  await assert.rejects(f.text('Bakı'), /Expected one row/);
  assert.equal(f.tables.jobs[0].location_name, undefined);
});
test('all active jobs paginate next/back with stable ordering and exclude pending/expired', async () => {
  const f = fixture();
  seedJobs(f);
  f.tables.jobs.push(
    { id: 13, title: 'Pending', status: 'pending' },
    { id: 14, title: 'Expired', status: 'active', expires_at: '2020-01-01' },
  );
  await f.action('job:all');
  const first = last(f, 'sendJobList').args[2];
  assert.equal(first.filter((r) => r.id.startsWith('job:detail')).length, 5);
  assert.equal(first[0].id, 'job:detail:all:0:12');
  assert.ok(first.some((r) => r.id === 'job:page:all:1'));
  await f.action('job:page:all:1');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:all:0'));
  await f.action('job:page:all:2');
  const final = last(f, 'sendJobList').args[2];
  assert.equal(final.filter((r) => r.id.startsWith('job:detail')).length, 2);
  assert.ok(!final.some((r) => r.id === 'job:page:all:3'));
  await f.action('job:page:all:0');
  assert.deepEqual(last(f, 'sendJobList').args[2], first);
  assert.ok(
    f.calls.filter((c) => c.table === 'jobs').every((c) => c.orders.some(([key]) => key === 'id')),
  );
});
test('matching applies title, city, work mode and salary; all view is unfiltered', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 5);
  f.tables.jobs[1].location_name = 'Gəncə';
  f.tables.jobs[2].work_mode = 'remote';
  f.tables.jobs[3].salary_max = 800;
  f.tables.jobs[4].title = 'Driver';
  await f.action('job:matches');
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    1,
  );
  await f.action('job:all');
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    5,
  );
});
test('remote matching does not require employer city to match seeker city', async () => {
  const f = fixture();
  await seeker(f);
  f.tables.job_seeker_preferences[0].work_modes = ['remote'];
  seedJobs(f, 1);
  f.tables.jobs[0].work_mode = 'remote';
  f.tables.jobs[0].location_name = 'Gəncə';
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('incomplete profile and empty/out-of-range pages show navigable controls', async () => {
  const f = fixture();
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobButtons').args[2].some((b) => b.id === 'job:seeker'));
  await f.action('job:all');
  assert.deepEqual(
    last(f, 'sendJobList').args[2].map((r) => r.id),
    ['job:menu'],
  );
  await f.action('job:page:all:9');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:all:8'));
});
test('detail rechecks active status and sends description/contact then back controls', async () => {
  const f = fixture();
  seedJobs(f, 1);
  f.tables.jobs[0].description = 'D'.repeat(1500);
  await f.action('job:all');
  await f.action('job:detail:all:0:1');
  assert.match(last(f, 'sendText').args[1], /\+994501234567/);
  assert.ok(last(f, 'sendText').args[1].includes('D'.repeat(1500)));
  assert.ok(last(f, 'sendJobButtons').args[2].some((b) => b.id === 'job:page:all:0'));
  f.tables.jobs[0].status = 'closed';
  await f.action('job:detail:all:0:1');
  assert.match(last(f, 'sendJobButtons').args[1], /artıq aktiv deyil/);
});
test('stale pagination does not interrupt new employer flow', async () => {
  const f = fixture();
  await f.action('job:all');
  await f.action('job:employer');
  await f.action('job:page:all:1');
  assert.equal(f.state(), 'employer_company');
});
test('profile view reads persisted seeker and employer data', async () => {
  const f = fixture();
  await seeker(f);
  await f.action('job:profile');
  assert.match(last(f, 'sendText').args[1], /Frontend/);
  assert.match(last(f, 'sendText').args[1], /1000/);
  assert.equal(f.state(), 'ready');
});
test('only pending jobs can be approved/rejected; approval records publication and notifies', async () => {
  const f = fixture();
  const job = await employerDraft(f);
  await assert.rejects(f.admin.approve(job.id), /not found/);
  await f.action(`job:confirm:${job.id}`);
  await f.admin.approve(job.id);
  assert.equal(job.status, 'active');
  assert.ok(job.published_at);
  assert.equal(last(f, 'sendJobMainMenu').args[0], 'wa1');
  await assert.rejects(f.admin.reject(job.id, 'bad'), /not found/);
});
test('rejection preserves employer metadata and does not make vacancy active', async () => {
  const f = fixture();
  const job = await employerDraft(f);
  await f.action(`job:confirm:${job.id}`);
  await f.admin.reject(job.id, 'Incomplete');
  assert.equal(job.status, 'rejected');
  assert.equal(job.metadata.employer_profile_id, 'p1');
  assert.equal(job.metadata.moderation_reason, 'Incomplete');
});
test('webhook separates text, interactive IDs and unsupported media', async () => {
  const f = fixture();
  const handler = new JobAgentWebhookService(f.service, f.whatsapp);
  const payload = (messages) => ({
    entry: [
      {
        changes: [
          { value: { messages, contacts: [{ wa_id: 'wa1', profile: { name: 'Xeyyam' } }] } },
        ],
      },
    ],
  });
  await handler.process(
    payload([
      {
        id: '1',
        from: 'wa1',
        type: 'interactive',
        interactive: { list_reply: { id: 'job:employer', title: 'ignored' } },
      },
      { id: '2', from: 'wa1', type: 'text', text: { body: 'Yelo' } },
      { id: '3', from: 'wa1', type: 'image', image: { id: 'img' } },
    ]),
  );
  assert.equal(f.state(), 'employer_job_title');
  assert.equal(f.tables.employer_profiles[0].company_name, 'Yelo');
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(last(f, 'sendJobMainMenu').args[0], 'wa1');
});
test('Telegram rejects untrusted chat/secret and preserves admin command routing', async () => {
  const f = fixture();
  const messages = [];
  const legacy = [];
  const controller = new TelegramController(
    new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'fixture-secret', TELEGRAM_ADMIN_CHAT_ID: '7' }),
    {
      sendMessage: async (text) => messages.push(text),
      handleCommand: async (text) => legacy.push(text),
    },
    f.admin,
  );
  await controller.webhook({ message: { chat: { id: 8 }, text: '/pending' } }, 'fixture-secret');
  await controller.webhook({ message: { chat: { id: 7 }, text: '/pending' } }, 'wrong');
  assert.equal(messages.length, 0);
  await controller.webhook({ message: { chat: { id: 7 }, text: '/pending' } }, 'fixture-secret');
  assert.equal(messages.length, 1);
  await controller.webhook({ message: { chat: { id: 7 }, text: '/help' } }, 'fixture-secret');
  assert.deepEqual(legacy, ['/help']);
});
test('interactive client serializes job menu/buttons within Meta limits and preserves BSUID routing', async () => {
  const client = new WhatsAppClientService(
    new ConfigService({ META_PHONE_NUMBER_ID: 'fixture-phone' }),
  );
  const requests = [];
  client.graphRequest = async (path, init) => {
    requests.push(JSON.parse(init.body));
    return { messages: [{ id: 'sent' }] };
  };
  await client.sendJobMainMenu('wa1');
  const menu = requests[0];
  assert.equal(menu.interactive.type, 'list');
  assert.equal(menu.interactive.action.sections[0].rows.length, 5);
  assert.deepEqual(
    menu.interactive.action.sections[0].rows.map((r) => r.id),
    ['job:seeker', 'job:employer', 'job:all', 'job:profile', 'job:matches'],
  );
  assert.doesNotMatch(JSON.stringify(menu), /AdYarat|reklam|video/);
  await client.sendJobButtons('AZ.123', 'Prompt', [{ id: 'job:menu', title: 'Əsas menyu' }]);
  assert.equal(requests[1].recipient, 'AZ.123');
  await assert.rejects(
    client.sendJobList(
      'wa1',
      'body',
      Array.from({ length: 11 }, () => ({ id: 'id', title: 'Title' })),
    ),
    /limits/,
  );
  await assert.rejects(
    client.sendJobButtons('wa1', 'B'.repeat(1025), [{ id: 'id', title: 'Title' }]),
    /limits/,
  );
});

test('Telegram pending list splits many vacancies into bounded messages', async () => {
  const f = fixture();
  seedJobs(f, 10);
  f.tables.jobs.forEach((j) => {
    j.status = 'pending';
    j.description = 'D'.repeat(1500);
  });
  const messages = [];
  const controller = new TelegramController(
    new ConfigService({ TELEGRAM_ADMIN_CHAT_ID: '7', TELEGRAM_WEBHOOK_SECRET: 'fixture-secret' }),
    { sendMessage: async (text) => messages.push(text) },
    f.admin,
  );
  await controller.webhook({ message: { chat: { id: 7 }, text: '/pending' } }, 'fixture-secret');
  assert.equal(messages.length, 11);
  assert.ok(messages.every((text) => text.length <= 4096));
});
