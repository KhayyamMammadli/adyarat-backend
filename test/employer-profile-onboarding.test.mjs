import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, employerDraft, last } from './helpers/job-agent-fixture.mjs';

async function profile(f) {
  await f.action('job:employer');
  for (const t of ['Company', '1500315641', 'hr@example.com']) await f.text(t);
}
test('employer onboarding persists company/VÖEN/email and creates no vacancy until explicit Add', async () => {
  const f = fixture();
  await profile(f);
  assert.equal(f.state(), 'employer_ready');
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.tables.employer_profiles[0].voen, '1500315641');
  assert.ok(last(f, 'sendJobButtons').args[2].some((b) => b.id === 'job:employer:new'));
  await f.text('Frontend');
  assert.equal(f.tables.jobs.length, 0);
  await f.action('job:employer:new');
  assert.equal(f.state(), 'employer_job_title');
  await f.text('Frontend');
  assert.equal(f.tables.jobs.length, 1);
  assert.equal(f.tables.jobs[0].company_name, 'Company');
});
test('returning employer reuses saved company and credentials without asking profile fields again', async () => {
  const f = fixture();
  await profile(f);
  await f.action('job:menu');
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_ready');
  await f.action('job:employer:new');
  assert.equal(f.state(), 'employer_job_title');
  await f.text('One');
  await f.action('job:menu');
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_ready');
  await f.action('job:employer:new');
  await f.text('Two');
  assert.deepEqual(
    f.tables.jobs.map((j) => j.company_name),
    ['Company', 'Company'],
  );
  assert.equal(f.tables.employer_profiles[0].voen, '1500315641');
});
test('existing company missing credentials resumes profile creation rather than creating an ad', async () => {
  const f = fixture();
  await f.text('salam');
  f.tables.employer_profiles.push({ profile_id: 'p1', company_name: 'Existing', metadata: {} });
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_voen');
  await f.text('1500315641');
  await f.text('hr@example.com');
  assert.equal(f.state(), 'employer_ready');
  assert.equal(f.tables.jobs.length, 0);
});
test('company can be changed explicitly without overwriting credentials or creating a vacancy', async () => {
  const f = fixture();
  await profile(f);
  await f.action('job:employer:edit');
  assert.equal(f.state(), 'employer_company');
  await f.text('New company');
  assert.equal(f.state(), 'employer_ready');
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.tables.employer_profiles[0].company_name, 'New company');
  assert.equal(f.tables.employer_profiles[0].email, 'hr@example.com');
});
test('stale employer Add/Edit controls cannot interrupt seeker onboarding', async () => {
  const f = fixture();
  await profile(f);
  await f.action('job:seeker');
  await f.action('job:employer:new');
  await f.action('job:employer:edit');
  assert.equal(f.state(), 'seeker_category');
  assert.equal(f.tables.jobs.length, 0);
});
test('repeat vacancy creation asks a fresh office location while reusing employer identity', async () => {
  const f = fixture();
  const first = await employerDraft(f);
  await f.action('job:confirm:1');
  await f.action('job:employer');
  await f.action('job:employer:new');
  await f.text('Second vacancy');
  await f.text('Gəncə');
  await f.action('job:mode:employer:office');
  assert.equal(f.state(), 'employer_pin');
  assert.equal(f.tables.jobs[1].latitude, undefined);
  await f.service.handleLocation('wa1', { latitude: 40.68, longitude: 46.36 });
  assert.equal(f.tables.jobs[1].latitude, 40.68);
  assert.equal(first.latitude, 40.4093);
  assert.equal(f.tables.jobs[1].company_name, first.company_name);
});
test('redraft uses explicit Add and preserves profile data', async () => {
  const f = fixture();
  await employerDraft(f);
  await f.action('job:employer:new');
  assert.equal(f.state(), 'employer_job_title');
  assert.equal(f.tables.employer_profiles[0].metadata.draft_job_id, null);
  assert.equal(f.tables.employer_profiles[0].company_name, 'Yelo');
});

test('saved employer profile buttons fit native WhatsApp limits', async () => {
  const { WhatsAppClientService } = await import('../dist/whatsapp/whatsapp-client.service.js');
  const { ConfigService } = await import('@nestjs/config');
  const f = fixture();
  await profile(f);
  const client = new WhatsAppClientService(
    new ConfigService({ META_PHONE_NUMBER_ID: 'fixture-phone' }),
  );
  client.graphRequest = async () => ({ messages: [{ id: 'sent' }] });
  await client.sendJobButtons(...last(f, 'sendJobButtons').args);
});
