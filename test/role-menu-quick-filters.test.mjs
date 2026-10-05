import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
import { fixture, seeker, seedJobs, last, approvedEmployer } from './helpers/job-agent-fixture.mjs';

test('completed role menus hide registration and employer can publish after returning home', async () => {
  const client = new WhatsAppClientService(new ConfigService());
  let rows;
  client.sendJobList = async (_to, _body, r) => {
    rows = r;
    return 'ok';
  };
  await client.sendJobMainMenu('wa', undefined, 'seeker');
  assert(!rows.some((r) => ['job:seeker', 'job:employer'].includes(r.id)));
  assert(rows.some((r) => r.id === 'job:filters'));
  await client.sendJobMainMenu('wa', undefined, 'employer');
  assert(rows.some((r) => r.id === 'job:employer:new'));
  assert(!rows.some((r) => r.id === 'job:employer'));
  const f = fixture();
  await approvedEmployer(f);
  await f.action('job:menu');
  assert.equal(last(f, 'sendJobMainMenu').args[2], 'employer');
  await f.action('job:employer:new');
  assert.equal(f.state(), 'employer_job_title');
});
test('city button and minimum salary immediately return results and preserve pagination filters', async () => {
  const f = fixture();
  await seeker(f);
  seedJobs(f, 12);
  f.tables.jobs[0].location_name = 'Gəncə';
  f.tables.jobs[1].salary_max = 100;
  await f.action('job:filters');
  await f.action('job:filter:city');
  await f.action('job:filter:city:0');
  assert.equal(f.state(), 'browse_all');
  assert.equal(f.tables.job_agent_profiles[0].browse_filters.location_name, 'Bakı');
  await f.action('job:filter:salary');
  await f.text('1000');
  assert.equal(f.state(), 'browse_all');
  assert.equal(f.tables.job_agent_profiles[0].browse_filters.salary_min, 1000);
  await f.action('job:page:all:1');
  const ids = last(f, 'sendJobList')
    .args[2].filter((r) => r.id.startsWith('job:detail:'))
    .map((r) => Number(r.id.split(':').at(-1)));
  assert(!ids.includes(1) && !ids.includes(2));
  await f.action('job:menu');
  assert.equal(last(f, 'sendJobMainMenu').args[2], 'seeker');
  assert.deepEqual(f.tables.job_agent_profiles[0].browse_filters, {});
});
