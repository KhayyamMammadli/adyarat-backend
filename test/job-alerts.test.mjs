import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fixture, last } from './helpers/job-agent-fixture.mjs';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
import { ConfigService } from '@nestjs/config';
import { JobAlertsWorker } from '../dist/job-agent/job-alerts.worker.js';

test('guest creates opted-in criteria, edits and confirms deletion without registration', async () => {
  const f = fixture();
  f.tables.job_categories.push({ id: 1, name: 'Satış', is_active: true });
  await f.action('job:alerts:new');
  const token = f.tables.job_agent_profiles[0].browse_filters.alert.token;
  const action = (c) => f.action(`job:alert:${token}:${c}`);
  await action('cat_1');
  await action('salary');
  await action('salary_800');
  await action('save');
  assert.equal(f.tables.job_alert_subscriptions.length, 0);
  await action('consent');
  assert.equal(f.tables.job_alert_subscriptions[0].salary_min, 800);
  assert.equal(f.tables.job_seeker_preferences.length, 0);
  const a = f.tables.job_alert_subscriptions[0];
  a.revision = 1;
  await f.action(`job:alerts:open:${a.id}`);
  const edit = f.tables.job_agent_profiles[0].browse_filters.alert.token;
  await f.action(`job:alert:${edit}:salary`);
  await f.action(`job:alert:${edit}:salary_other`);
  await f.text('1200');
  await f.action(`job:alert:${edit}:save`);
  await f.action(`job:alert:${edit}:consent`);
  assert.equal(a.salary_min, 1200);
  await f.action(`job:alerts:open:${a.id}`);
  const del = f.tables.job_agent_profiles[0].browse_filters.alert.token;
  await f.action(`job:alert:${del}:delete`);
  assert.equal(f.tables.job_alert_subscriptions.length, 1);
  await f.action(`job:alert:${del}:yes_delete`);
  assert.equal(f.tables.job_alert_subscriptions.length, 0);
});
test('ownership and stale buttons cannot change another subscription', async () => {
  const f = fixture();
  f.tables.job_alert_subscriptions.push({ id: 7, profile_id: 'other', revision: 1 });
  await f.action('job:alerts:open:7');
  assert.match(last(f, 'sendText').args[1], /tapılmadı/);
  await f.action('job:alert:stale:yes_delete');
  assert.equal(f.tables.job_alert_subscriptions.length, 1);
});
test('real SQL queues matching publications once and cancels deleted criteria', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table job_agent_profiles(id uuid primary key,wa_id text);
 create table job_categories(id bigint primary key,name text,is_active boolean);
 create table jobs(id bigint primary key,status text,category_id bigint,work_mode text,location_name text,salary_currency text,salary_min numeric,salary_max numeric,expires_at timestamptz,delete_at timestamptz);
 insert into job_agent_profiles values('00000000-0000-0000-0000-000000000001','wa1');
 insert into job_categories values(1,'Satış',true),(2,'IT',true);`);
    await db.exec(
      await readFile(
        new URL('../supabase/migrations/20261009102934_seeker_vacancy_alerts.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(`insert into job_alert_subscriptions(profile_id,category_id,location_name,salary_min) values
 ('00000000-0000-0000-0000-000000000001',1,'Bakı',800),('00000000-0000-0000-0000-000000000001',1,null,500);
 insert into jobs values(1,'pending',1,'office','Baku','AZN',1000,1200,null,now()+interval '28 days'),
 (2,'active',2,'office','Bakı','AZN',1000,1200,null,now()+interval '28 days'),
 (3,'scheduled',1,'remote','Gəncə','AZN',1000,1200,null,now()+interval '28 days'),
 (4,'active',1,'office','Bakı','USD',1000,1200,null,now()+interval '28 days');
 update jobs set status='active' where id=1;update jobs set status='active' where id=1;
 update jobs set status='active' where id=3;`);
    assert.deepEqual(
      (await db.query('select job_id from job_alert_deliveries order by job_id')).rows.map(
        (r) => r.job_id,
      ),
      [1, 3],
    );
    assert.equal((await db.query('select * from claim_job_alert_deliveries()')).rows.length, 2);
    assert.equal((await db.query('select * from claim_job_alert_deliveries()')).rows.length, 0);
    assert.ok((await db.query('select job_alert_delivery_target(1) as target')).rows[0].target);
    await db.exec('delete from job_alert_subscriptions');
    assert.equal(
      (await db.query('select job_alert_delivery_target(1) as target')).rows[0].target,
      null,
    );
    await db.exec("update job_alert_deliveries set status='queued'");
    await db.query('select * from claim_job_alert_deliveries()');
    assert.deepEqual(
      (await db.query('select status from job_alert_deliveries')).rows.map((r) => r.status),
      ['cancelled', 'cancelled'],
    );
    await assert.rejects(
      db.exec('set role anon;select * from job_alert_subscriptions'),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
test('approved template serializes six parameters and returns acknowledgement', async () => {
  const wa = new WhatsAppClientService(
    new ConfigService({
      META_PHONE_NUMBER_ID: 'phone',
      JOB_ALERT_TEMPLATE_NAME: 'vacancy',
      JOB_ALERT_TEMPLATE_LANGUAGE: 'en',
    }),
  );
  let payload;
  wa.graphRequest = async (_p, init) => {
    payload = JSON.parse(init.body);
    return { messages: [{ id: 'ack' }] };
  };
  assert.equal(
    await wa.sendJobAlertTemplate('wa1', {
      id: 7,
      title: 'Seller',
      company_name: 'Shop',
      location_name: 'Bakı',
      salary_min: 800,
      contact_phone: '123',
    }),
    'ack',
  );
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.components[0].parameters.length, 6);
  assert.equal(payload.template.components[0].parameters[5].text, '7');
});
test('disabled worker never claims or sends; uncertain send never retries automatically', async () => {
  let calls = 0;
  const updates = [];
  const client = {
    rpc: async (name) => {
      calls++;
      return {
        data:
          name === 'claim_job_alert_deliveries' ? [{ id: 1 }] : { wa_id: 'wa1', job: { id: 7 } },
      };
    },
    from: () => ({
      update: (value) => {
        updates.push(value);
        return {
          eq() {
            return this;
          },
          then(resolve) {
            resolve({ error: null });
          },
        };
      },
    }),
  };
  const worker = new JobAlertsWorker(
    { client },
    {
      sendJobAlertTemplate: async () => {
        throw new Error('timeout');
      },
    },
    new ConfigService({ JOB_ALERTS_ENABLED: 'false' }),
  );
  await worker.tick();
  assert.equal(calls, 0);
  const enabled = new JobAlertsWorker(
    { client },
    {
      sendJobAlertTemplate: async () => {
        throw new Error('timeout');
      },
    },
    new ConfigService({
      JOB_ALERTS_ENABLED: 'true',
      JOB_ALERT_TEMPLATE_NAME: 'vacancy',
      JOB_ALERT_TEMPLATE_LANGUAGE: 'en',
    }),
  );
  await enabled.tick();
  assert.equal(updates[0].status, 'unknown');
});
