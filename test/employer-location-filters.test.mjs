import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, employerDraft, seeker, seedJobs, last } from './helpers/job-agent-fixture.mjs';
import {
  validVoen,
  validEmail,
  validCoordinates,
  distanceKm,
} from '../dist/job-agent/vacancy-validation.js';
import { matchingVacancies, filteredVacancies } from '../dist/job-agent/vacancy-query.js';
import { JobAgentWebhookService } from '../dist/job-agent/job-agent-webhook.service.js';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
import { ConfigService } from '@nestjs/config';

const point = { latitude: 40.4093, longitude: 49.8671, address: 'Bakı, Nizami 1' };
async function start(f, mode = 'office') {
  await f.action('job:employer');
  for (const t of ['Company', '1500315641', 'hr@example.com']) await f.text(t);
  await f.action('job:employer:new');
  for (const t of ['Frontend', 'Bakı']) await f.text(t);
  await f.action(`job:mode:employer:${mode}`);
}
async function finish(f) {
  for (const t of ['1000', '2000', 'React']) await f.text(t);
  await f.action('job:contact:skip');
}
const ids = (f) =>
  last(f, 'sendJobList')
    .args[2].filter((r) => r.id.startsWith('job:detail'))
    .map((r) => Number(r.id.split(':').at(-1)));

test('VÖEN accepts only nonzero ten digits and blocks vacancy insertion until present', async () => {
  const f = fixture();
  await f.action('job:employer');
  await f.text('Company');
  for (const t of ['', '123', '12345678901', '12abcdefgh', '0000000000', 'Title']) {
    await f.text(t);
    assert.equal(f.state(), 'employer_voen');
    assert.equal(f.tables.jobs.length, 0);
  }
  await f.text('1500315641');
  assert.equal(f.tables.employer_profiles[0].voen, '1500315641');
  assert.equal(f.state(), 'employer_email');
  assert.equal(validVoen(' 1500315641'), false);
});
test('email validation rejects malformed values, persists email, never exposes WhatsApp as public phone', async () => {
  const f = fixture();
  await f.action('job:employer');
  await f.text('Company');
  await f.text('1500315641');
  for (const t of ['bad', 'a@', 'a@b', 'a b@example.com', 'a@-example.com', 'a..b@example.com']) {
    await f.text(t);
    assert.equal(f.state(), 'employer_email');
    assert.equal(validEmail(t), false);
  }
  await f.text('HR@example.com');
  assert.equal(f.state(), 'employer_ready');
  assert.equal(f.tables.jobs.length, 0);
  await f.action('job:employer:new');
  await f.text('Frontend');
  assert.equal(f.tables.employer_profiles[0].email, 'hr@example.com');
  assert.equal(f.tables.jobs[0].contact_email, 'hr@example.com');
  assert.equal(f.tables.jobs[0].contact_phone, undefined);
});
test('legacy employer without VÖEN must complete credentials before its next vacancy', async () => {
  const f = fixture();
  await f.text('salam');
  f.tables.employer_profiles.push({ profile_id: 'p1', company_name: 'Old', metadata: {} });
  await f.action('job:employer');
  await f.text('Old');
  await f.text('A title');
  assert.equal(f.state(), 'employer_voen');
  assert.equal(f.tables.jobs.length, 0);
});
for (const mode of ['office', 'hybrid'])
  test(`${mode} needs valid GPS and stores native location/address before salary`, async () => {
    const f = fixture();
    await start(f, mode);
    assert.equal(f.state(), 'employer_pin');
    await f.text('1000');
    assert.equal(f.state(), 'employer_pin');
    for (const location of [
      { latitude: 91, longitude: 10 },
      { latitude: null, longitude: 0 },
      { latitude: 0, longitude: NaN },
    ]) {
      await f.service.handleLocation('wa1', location);
      assert.equal(f.state(), 'employer_pin');
    }
    await f.service.handleLocation('wa1', point);
    assert.equal(f.state(), 'employer_salary_min');
    assert.equal(f.tables.jobs[0].latitude, point.latitude);
    assert.equal(f.tables.jobs[0].longitude, point.longitude);
    assert.equal(f.tables.jobs[0].location_name, point.address);
    await finish(f);
    await f.action('job:confirm:1');
    assert.equal(f.tables.jobs[0].status, 'pending');
  });
test('remote skips GPS and optional phone skip completes moderation without public WhatsApp number', async () => {
  const f = fixture();
  await start(f, 'remote');
  assert.equal(f.state(), 'employer_salary_min');
  await finish(f);
  const job = f.tables.jobs[0];
  assert.equal(job.contact_phone, null);
  assert.equal(job.latitude, undefined);
  await f.action('job:confirm:1');
  assert.equal(job.status, 'pending');
  assert.doesNotMatch(f.notices[0], /wa1/);
});
test('optional public contact still validates, stale contact controls do not affect other flows', async () => {
  const f = fixture();
  await start(f, 'remote');
  for (const t of ['0', '0', 'Description']) await f.text(t);
  assert.equal(f.state(), 'employer_contact_choice');
  await f.action('job:contact:add');
  await f.text('123');
  assert.equal(f.state(), 'employer_contact');
  await f.text('+994501234567');
  assert.equal(f.tables.jobs[0].contact_phone, '+994501234567');
  await f.action('job:seeker');
  await f.action('job:contact:skip');
  assert.equal(f.state(), 'seeker_category');
});
test('publication guard catches missing credentials/GPS even for existing draft confirm states', async () => {
  const f = fixture();
  const job = await employerDraft(f);
  f.tables.employer_profiles[0].voen = null;
  await f.action('job:confirm:1');
  assert.equal(job.status, 'draft');
  assert.equal(f.state(), 'employer_voen');
  await f.text('1500315641');
  assert.equal(f.state(), 'employer_confirm');
  assert.equal(f.tables.jobs.length, 1);
  job.latitude = null;
  await f.action('job:confirm:1');
  assert.equal(f.state(), 'employer_pin');
  assert.equal(job.status, 'draft');
});
test('location webhook is routed into employer flow and unsupported stale locations preserve state', async () => {
  const f = fixture();
  await start(f);
  const handler = new JobAgentWebhookService(f.service, f.whatsapp);
  await handler.process({
    entry: [
      {
        changes: [
          { value: { messages: [{ id: 'loc1', from: 'wa1', type: 'location', location: point }] } },
        ],
      },
    ],
  });
  assert.equal(f.tables.jobs[0].latitude, point.latitude);
  await f.action('job:seeker');
  await f.service.handleLocation('wa1', point);
  assert.equal(f.state(), 'seeker_category');
});
test('GPS detail sends clickable Maps link and native WhatsApp location; old records remain navigable', async () => {
  const f = fixture();
  seedJobs(f, 2);
  Object.assign(f.tables.jobs[0], point);
  await f.action('job:all');
  await f.action('job:detail:all:0:1');
  assert.match(last(f, 'sendText').args[1], /google.com\/maps\/search/);
  assert.deepEqual(last(f, 'sendJobLocation').args.slice(1, 3), [point.latitude, point.longitude]);
  const count = f.sent.filter((c) => c.name === 'sendJobLocation').length;
  await f.action('job:detail:all:0:2');
  assert.equal(f.sent.filter((c) => c.name === 'sendJobLocation').length, count);
  assert.doesNotMatch(last(f, 'sendText').args[1], /undefined|NaN/);
});
test('all filters combine with pagination and clear/reset leaves saved seeker preference intact', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 15);
  Object.assign(f.tables.jobs[0], { work_mode: 'remote' });
  f.tables.jobs[1].location_name = 'Gəncə';
  f.tables.jobs[2].salary_max = 500;
  await f.action('job:all');
  await f.action('job:filter:menu');
  for (const [field, text] of [
    ['title', 'Frontend'],
    ['city', 'Baki'],
    ['salary', '1000'],
  ]) {
    await f.action(`job:filter:${field}`);
    await f.text(text);
  }
  await f.action('job:filter:mode');
  await f.action('job:filter:mode:office');
  await f.action('job:filter:apply');
  assert.deepEqual(ids(f), [15, 14, 13, 12, 11]);
  await f.action('job:page:all:1');
  assert.deepEqual(ids(f), [10, 9, 8, 7, 6]);
  assert.equal(last(f, 'sendJobList').args[2].length, 10);
  await f.action('job:page:all:2');
  assert.deepEqual(ids(f), [5, 4]);
  await f.action('job:filter:clear');
  assert.equal(ids(f)[0], 15);
  assert.equal(f.tables.job_seeker_preferences[0].desired_title, 'Frontend');
  await f.action('job:filter:menu');
  await f.action('job:filter:title');
  await f.text('Other');
  await f.action('job:menu');
  assert.deepEqual(f.tables.job_agent_profiles[0].browse_filters, {});
  await f.action('job:filter:mode:remote');
  assert.equal(f.state(), 'ready');
});
test('category picker paginates and rejects nonexistent/inactive categories', async () => {
  const f = fixture();
  seedJobs(f, 2);
  f.tables.jobs[0].category_id = 7;
  f.tables.jobs[1].category_id = 8;
  f.tables.job_categories.push(
    ...Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: `Category ${i + 1}`,
      is_active: i !== 7,
    })),
  );
  await f.action('job:all');
  await f.action('job:filter:menu');
  await f.action('job:filter:category');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:filter:categories:1'));
  await f.action('job:filter:categories:1');
  await f.action('job:filter:category:8');
  assert.equal(f.state(), 'filter_category');
  await f.action('job:filter:category:7');
  await f.action('job:filter:apply');
  assert.deepEqual(ids(f), [1]);
});
test('radius filters before pagination, excludes missing/far GPS and honors persisted matching radius', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 14);
  f.tables.jobs.forEach((j, i) =>
    Object.assign(j, i < 7 ? point : { latitude: 41.7, longitude: 46.3 }),
  );
  f.tables.jobs[0].latitude = null;
  await f.action('job:all');
  await f.action('job:filter:menu');
  await f.action('job:filter:center');
  await f.service.handleLocation('wa1', point);
  await f.action('job:filter:radius:5');
  await f.action('job:filter:apply');
  assert.deepEqual(ids(f), [7, 6, 5, 4, 3]);
  await f.action('job:page:all:1');
  assert.deepEqual(ids(f), [2]);
  const pref = f.tables.job_seeker_preferences[0];
  Object.assign(pref, point, { radius_km: 5 });
  f.tables.jobs[13].work_mode = 'remote';
  pref.work_modes = ['office', 'remote'];
  const result = await matchingVacancies(f.client, pref);
  assert.equal(result.data.length, 7);
  assert.ok(result.data.some((j) => j.id === 14));
  assert.equal(distanceKm(point, point), 0);
  assert.ok(distanceKm(point, f.tables.jobs[7]) > 100);
  assert.equal(validCoordinates({ latitude: 0, longitude: 0 }), true);
});
test('real Supabase SDK applies radius RPC plus filters and Range rather than filtering page in memory', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  let request;
  const client = createClient('https://fixture.invalid', 'fixture-key', {
    global: {
      fetch: async (url, init) => {
        request = { url: new URL(String(url)), init };
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  await filteredVacancies(client, {
    ...point,
    radius_km: 10,
    title: 'React, (Next)',
    work_mode: 'office',
    salary_min: 1000,
  })
    .order('id')
    .range(5, 10);
  assert.match(request.url.pathname, /rpc\/jobs_within_radius$/);
  assert.equal(JSON.parse(request.init.body).max_km, 10);
  assert.equal(request.url.searchParams.get('work_mode'), 'eq.office');
  assert.equal(request.url.searchParams.get('offset'), '5');
  assert.equal(request.url.searchParams.get('limit'), '6');
});
test('native location client preserves recipient routing and rejects invalid coordinates', async () => {
  const client = new WhatsAppClientService(
    new ConfigService({ META_PHONE_NUMBER_ID: 'fixture-phone' }),
  );
  let body;
  client.graphRequest = async (_, init) => {
    body = JSON.parse(init.body);
    return { messages: [{ id: 'sent' }] };
  };
  await client.sendJobLocation('AZ.123', point.latitude, point.longitude, 'Company', point.address);
  assert.equal(body.type, 'location');
  assert.equal(body.recipient, 'AZ.123');
  assert.equal(body.location.address, point.address);
  await assert.rejects(client.sendJobLocation('wa1', 91, 0), /Invalid location/);
});

test('Maps fallback keeps detail controls usable if Meta native location is unavailable', async () => {
  const f = fixture();
  seedJobs(f, 1);
  Object.assign(f.tables.jobs[0], point);
  f.whatsapp.sendJobLocation = async () => {
    throw new Error('native unavailable');
  };
  await f.action('job:all');
  await f.action('job:detail:all:0:1');
  assert.match(last(f, 'sendText').args[1], /google.com\/maps\/search/);
  assert.ok(last(f, 'sendJobButtons').args[2].some((b) => b.id === 'job:page:all:0'));
});
test('filter and location save failures do not advance to the following step', async () => {
  const f = fixture();
  await start(f);
  f.fail('jobs', new Error('pin save failed'), 'update');
  await assert.rejects(f.service.handleLocation('wa1', point), /pin save failed/);
  assert.equal(f.state(), 'employer_pin');
  await f.action('job:all');
  await f.action('job:filter:menu');
  await f.action('job:filter:title');
  f.fail('job_agent_profiles', new Error('filters save failed'), 'update');
  await assert.rejects(f.text('Frontend'), /filters save failed/);
  assert.equal(f.state(), 'filter_title');
});
test('filter sessions survive service restart and remain independent between WhatsApp users', async () => {
  const { JobAgentService } = await import('../dist/job-agent/job-agent.service.js');
  const f = fixture();
  seedJobs(f, 4);
  await f.action('job:all');
  await f.action('job:filter:menu');
  await f.action('job:filter:title');
  await f.text('Frontend 1');
  const service = new JobAgentService({ client: f.client }, f.whatsapp, {
    sendMessage: async () => {},
  });
  await service.handleInteractive('wa1', 'job:filter:apply');
  assert.deepEqual(ids(f), [1]);
  await service.handleInteractive('wa2', 'job:all');
  assert.equal(ids(f).length, 4);
  await service.handleInteractive('wa1', 'job:page:all:0');
  assert.deepEqual(ids(f), [1]);
});
test('all WhatsApp filter menus, category and vacancy pages obey interactive limits and detail text bounds', async () => {
  const f = fixture();
  seedJobs(f, 12);
  await f.action('job:all');
  await f.action('job:page:all:1');
  await f.action('job:filter:menu');
  await f.action('job:filter:mode');
  await f.action('job:filter:mode:office');
  await f.action('job:filter:center');
  await f.service.handleLocation('wa1', point);
  for (const c of f.sent) {
    if (c.name === 'sendJobList') {
      assert.ok(c.args[2].length <= 10 && c.args[1].length <= 1024);
      c.args[2].forEach((r) =>
        assert.ok(r.title.length <= 24 && (r.description?.length ?? 0) <= 72),
      );
    }
    if (c.name === 'sendJobButtons') {
      assert.ok(c.args[2].length <= 3);
      c.args[2].forEach((b) => assert.ok(b.title.length <= 20));
    }
  }
  const job = {
    id: 1,
    title: 'T'.repeat(120),
    company_name: 'C'.repeat(160),
    location_name: 'A'.repeat(250),
    ...point,
    description: 'D'.repeat(1500),
    contact_email: 'E'.repeat(254),
    source_url: 'U'.repeat(1000),
    source: 'S'.repeat(40),
    metadata: { requirements: 'R'.repeat(400) },
  };
  assert.ok(f.service.formatJob(job).length <= 4096);
});
