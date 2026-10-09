import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, seedJobs, last, approvedEmployer } from './helpers/job-agent-fixture.mjs';
test('arbitrary first text opens five active jobs without identity or preference questions; pagination and details record browsing', async () => {
  const f = fixture();
  seedJobs(f, 12);
  await f.text('İş varmı?');
  assert.equal(f.state(), 'browse_all');
  assert.equal(f.tables.job_seeker_preferences.length, 0);
  assert.equal(f.tables.job_agent_profiles[0].role, undefined);
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    5,
  );
  await f.action('job:page:all:1');
  assert(last(f, 'sendJobList').args[2].length <= 10);
  const detail = last(f, 'sendJobList').args[2].find((r) => r.id.startsWith('job:detail')).id;
  await f.action(detail);
  assert.equal(f.tables.vacancy_browse_events.filter((e) => e.kind === 'detail').length, 1);
});
test('greeting is valid employer field data and cannot discard active vacancy creation', async () => {
  const f = fixture();
  await approvedEmployer(f);
  await f.action('job:employer:new');
  await f.text('Salam');
  assert.equal(f.tables.jobs[0].title, 'Salam');
  assert.notEqual(f.state(), 'ready');
});
test('analytics failure does not stop displaying vacancies', async () => {
  const f = fixture();
  seedJobs(f, 1);
  f.fail('vacancy_browse_events', new Error('Analytics down'), 'insert');
  await f.text('Salam');
  assert.equal(f.state(), 'browse_all');
  assert(last(f, 'sendText').args[1].includes('#1'));
});
