import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobAgentWebhookService } from '../dist/job-agent/job-agent-webhook.service.js';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
import { ConfigService } from '@nestjs/config';

import { fixture, employerDraft, seeker, seedJobs, last } from './helpers/job-agent-fixture.mjs';

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
  await f.text('1500315641');
  await f.text('hr@example.com');
  await f.action('job:employer:new');
  await f.text('Title');
  const draft = f.tables.jobs[0];
  await f.action('job:seeker');
  assert.equal(f.state(), 'seeker_category');
  assert.equal(f.tables.job_seeker_preferences[0].salary_min, null);
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_ready');
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
  await f.text('1500315641');
  await f.text('hr@example.com');
  await f.action('job:employer:new');
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
  assert.equal(f.noticeButtons[0].inline_keyboard[0][0].callback_data, 'tg:approve:1');
  await f.action(`job:confirm:${job.id}`);
  assert.equal(f.notices.length, 1);
});
test('maximum salary and contact validation preserve current state', async () => {
  const f = fixture();
  await f.action('job:employer');
  for (const text of ['Company', '1500315641', 'hr@example.com']) await f.text(text);
  await f.action('job:employer:new');
  for (const text of ['Title', 'Bakı', '3']) await f.text(text);
  await f.service.handleLocation('wa1', { latitude: 40.4, longitude: 49.8 });
  await f.text('1000');
  await f.text('900');
  assert.equal(f.state(), 'employer_salary_max');
  await f.text('1500');
  await f.text('Description');
  await f.action('job:contact:add');
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
  await f.text('1500315641');
  await f.text('hr@example.com');
  await f.action('job:employer:new');
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
    ['job:filter:menu', 'job:filter:clear', 'job:menu'],
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
  assert.equal(f.state(), 'employer_voen');
  assert.equal(f.tables.employer_profiles[0].company_name, 'Yelo');
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(last(f, 'sendJobMainMenu').args[0], 'wa1');
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

test('production-shaped approved job appears in all with visible chat preview despite incomplete seeker', async () => {
  const f = fixture();
  f.tables.jobs.push({
    id: 2,
    title: 'Frontend developer',
    company_name: 'Software MMC',
    location_name: 'Baki',
    work_mode: 'office',
    salary_min: '2000',
    salary_max: '3500',
    salary_currency: 'AZN',
    status: 'active',
    published_at: '2026-10-05T10:48:12.993Z',
    expires_at: null,
    created_at: '2026-10-05T10:45:00Z',
  });
  await f.action('job:all');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:detail:all:0:2'));
  assert.match(last(f, 'sendText').args[1], /#2 — Frontend developer/);
  await f.action('job:matches');
  assert.match(last(f, 'sendJobButtons').args[1], /profilinizi tamamlayın/);
  await seeker(f);
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:detail:matches:0:2'));
});
test('category-only profile matches active vacancies and category/title alternatives preserve salary/expiry', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 4);
  const pref = f.tables.job_seeker_preferences[0];
  pref.category_id = 7;
  pref.desired_title = null;
  f.tables.jobs[0].category_id = 7;
  f.tables.jobs[0].title = 'React engineer';
  f.tables.jobs[1].category_id = 7;
  f.tables.jobs[1].status = 'pending';
  f.tables.jobs[2].category_id = 7;
  f.tables.jobs[2].expires_at = '2020-01-01T00:00:00Z';
  await f.action('job:matches');
  assert.deepEqual(
    last(f, 'sendJobList')
      .args[2].filter((r) => r.id.startsWith('job:detail'))
      .map((r) => r.id),
    ['job:detail:matches:0:1'],
  );
  pref.desired_title = 'Frontend';
  await f.action('job:matches');
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    2,
  );
});
test('mixed work modes apply city exception only to remote jobs and exclude foreign currency', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 4);
  f.tables.job_seeker_preferences[0].work_modes = ['office', 'remote'];
  f.tables.jobs[0].location_name = 'Gəncə';
  f.tables.jobs[1].location_name = 'Gəncə';
  f.tables.jobs[1].work_mode = 'remote';
  f.tables.jobs[2].salary_currency = 'USD';
  f.tables.jobs[3].location_name = 'Baku';
  await f.action('job:matches');
  assert.deepEqual(
    last(f, 'sendJobList')
      .args[2].filter((r) => r.id.startsWith('job:detail'))
      .map((r) => r.id),
    ['job:detail:matches:0:4', 'job:detail:matches:0:2'],
  );
});
test('approved Asim fixture is included on matching pages and next/back retain chat previews', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 12);
  f.tables.jobs[11].company_name = 'Asim Hesenov';
  await f.action('job:matches');
  assert.match(last(f, 'sendText').args[1], /Asim Hesenov/);
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:matches:1'));
  const first = last(f, 'sendJobList').args[2];
  await f.action('job:page:matches:1');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:matches:0'));
  await f.action('job:page:matches:0');
  assert.deepEqual(last(f, 'sendJobList').args[2], first);
});

test('real Supabase SDK serializes independent expiry, category, location and salary OR groups safely', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const f = fixture();
  await seeker(f);
  const pref = f.tables.job_seeker_preferences[0];
  pref.category_id = 7;
  pref.desired_title = 'React, (Next)';
  let url;
  const client = createClient('https://fixture.invalid', 'fixture-key', {
    global: {
      fetch: async (input) => {
        url = new URL(String(input));
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  const query = client
    .from('jobs')
    .select('*')
    .eq('status', 'active')
    .or('expires_at.is.null,expires_at.gt.2026-10-05T00:00:00Z')
    .or(`category_id.eq.7,title.ilike.${f.service.filterLike(pref.desired_title)}`)
    .or(
      'work_mode.eq.remote,location_name.ilike."%Bakı%",location_name.ilike."%Baki%",location_name.ilike."%Baku%"',
    )
    .eq('salary_currency', 'AZN')
    .in('work_mode', ['office'])
    .or('salary_max.gte.1000,and(salary_max.is.null,salary_min.gte.1000)')
    .range(0, 5);
  await query;
  assert.equal(url.searchParams.getAll('or').length, 4);
  assert.match(url.searchParams.getAll('or')[1], /title.ilike."%React, \(Next\)%"/);
  assert.equal(url.searchParams.get('status'), 'eq.active');
});
