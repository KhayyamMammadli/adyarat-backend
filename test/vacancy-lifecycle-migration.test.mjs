import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const migration = await readFile(
  new URL(
    '../supabase/migrations/20261007114714_vacancy_lifecycle_management.sql',
    import.meta.url,
  ),
  'utf8',
);
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table jobs(id bigint generated always as identity primary key, title text,company_name text,description text,location_name text,latitude double precision,longitude double precision,work_mode text,salary_min numeric,salary_max numeric,contact_phone text,contact_email text,category_id bigint,source text default 'whatsapp',metadata jsonb default '{}'::jsonb,status text default 'draft' constraint jobs_status_check check(status in ('draft','pending','active','closed','paused','rejected')), created_at timestamptz default now(),updated_at timestamptz,published_at timestamptz,expires_at timestamptz);
 create table job_agent_profiles(id uuid primary key,wa_id text unique);
 create table employer_profiles(profile_id uuid primary key references job_agent_profiles(id) on delete cascade,registration_status text,verified boolean,photo_path text);
 create table job_seeker_preferences(profile_id uuid references job_agent_profiles(id) on delete cascade);
 create table job_agent_messages(profile_id uuid references job_agent_profiles(id) on delete set null);
 create table vacancy_notification_intents(job_id bigint references jobs(id) on delete cascade,profile_id uuid references job_agent_profiles(id) on delete cascade);
 create table telegram_staff(permissions text[]);
 create table telegram_staff_invites(permissions text[]);
 insert into job_agent_profiles values('${owner}','wa1'),('${other}','wa2');
 insert into employer_profiles values('${owner}','approved',true,'owner/photo.jpg');
 grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;`);
  await db.exec(migration);
  return db;
}
const query = async (db, sql, params = []) => (await db.query(sql, params)).rows;
async function job(db, values = {}) {
  const data = {
    title: 'Developer',
    company_name: 'Cafe',
    work_mode: 'remote',
    status: 'active',
    metadata: { employer_profile_id: owner },
    ...values,
  };
  const keys = Object.keys(data),
    args = Object.values(data).map((v) => (typeof v === 'object' ? JSON.stringify(v) : v));
  return (
    await query(
      db,
      `insert into jobs(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning *`,
      args,
    )
  )[0];
}
const edit = async (db, j, patch, profile = owner, admin = null) =>
  (
    await query(db, 'select save_vacancy_revision($1,$2,$3,$4,$5) result', [
      j.id,
      profile,
      admin,
      j.revision,
      JSON.stringify(patch),
    ])
  )[0].result;
test('PostgreSQL retention backfills, cannot be extended by edits, and deletes all expired statuses with cascading intents', async () => {
  const db = await database();
  try {
    const old = await job(db, { created_at: '2020-01-01', status: 'pending' }),
      recent = await job(db);
    await db.query('insert into vacancy_notification_intents values($1,$2)', [old.id, owner]);
    await db.query(
      "update jobs set created_at=now(),delete_at=now()+interval '100 days',expires_at=now()+interval '100 days' where id=$1",
      [old.id],
    );
    const preserved = (await query(db, 'select * from jobs where id=$1', [old.id]))[0];
    assert.equal(preserved.created_at.toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(preserved.delete_at.toISOString(), '2020-01-29T00:00:00.000Z');
    const run = (await query(db, 'select run_vacancy_lifecycle() result'))[0].result;
    assert.equal(run.deleted, 1);
    assert.equal((await query(db, 'select * from vacancy_notification_intents')).length, 0);
    assert.deepEqual(
      (await query(db, 'select id from jobs')).map((j) => j.id),
      [recent.id],
    );
    assert.equal((await query(db, 'select run_vacancy_lifecycle() result'))[0].result.deleted, 0);
  } finally {
    await db.close();
  }
});
test('PostgreSQL only approved, due, eligible scheduled jobs publish; future and unapproved jobs stay hidden', async () => {
  const db = await database();
  try {
    const due = await job(db, {
      status: 'scheduled',
      scheduled_at: new Date(Date.now() - 60000).toISOString(),
      approved_at: new Date().toISOString(),
    });
    const future = await job(db, {
      status: 'scheduled',
      scheduled_at: new Date(Date.now() + 3600000).toISOString(),
      approved_at: new Date().toISOString(),
    });
    const pending = await job(db, {
      status: 'pending',
      scheduled_at: new Date(Date.now() - 60000).toISOString(),
    });
    const blocked = await job(db, {
      status: 'scheduled',
      scheduled_at: new Date(Date.now() - 60000).toISOString(),
      approved_at: new Date().toISOString(),
      metadata: { business_registration_version: 1, employer_profile_id: other },
    });
    const run = (await query(db, 'select run_vacancy_lifecycle() result'))[0].result;
    assert.equal(run.published, 1);
    assert.equal((await query(db, 'select * from jobs where id=$1', [due.id]))[0].status, 'active');
    for (const j of [future, blocked])
      assert.equal(
        (await query(db, 'select * from jobs where id=$1', [j.id]))[0].status,
        'scheduled',
      );
    assert.equal(
      (await query(db, 'select * from jobs where id=$1', [pending.id]))[0].status,
      'pending',
    );
    assert.equal((await query(db, 'select run_vacancy_lifecycle() result'))[0].result.published, 0);
  } finally {
    await db.close();
  }
});
test('PostgreSQL revision saves enforce ownership, reject stale approval versions, preserve retention and re-moderate employer edits', async () => {
  const db = await database();
  try {
    const j = await job(db);
    assert.equal(await edit(db, j, { title: 'Steal' }, other), null);
    const updated = await edit(db, j, {
      title: 'Updated',
      status: 'active',
      created_at: '2099-01-01',
    });
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.status, 'pending');
    assert.equal(updated.revision, 2);
    assert.equal(Date.parse(updated.delete_at), new Date(j.delete_at).getTime());
    assert.equal(updated.approved_at, null);
    assert.equal(await edit(db, j, { title: 'Stale' }), null);
    await assert.rejects(
      edit(db, { ...j, revision: 2 }, { work_mode: 'office' }),
      (e) => e.code === '22023',
    );
    const gps = await edit(
      db,
      { ...j, revision: 2 },
      { work_mode: 'hybrid', latitude: 40.4, longitude: 49.8 },
    );
    assert.equal(gps.latitude, 40.4);
    await assert.rejects(
      edit(db, { ...j, revision: 3 }, { scheduled_at: '2099-01-01' }),
      (e) => e.code === '22023',
    );
  } finally {
    await db.close();
  }
});
test('PostgreSQL Telegram edits only target own vacancies and preserve scheduled vs immediate publishing', async () => {
  const db = await database();
  try {
    const j = await job(db, { source: 'telegram_admin', metadata: { telegram_admin_user_id: 7 } });
    assert.equal(await edit(db, j, { title: 'Other' }, null, '8'), null);
    const future = new Date(Date.now() + 3600000).toISOString();
    const updated = await edit(db, j, { title: 'Own edit', scheduled_at: future }, null, '7');
    assert.equal(updated.status, 'scheduled');
    assert.ok(updated.approved_at);
    assert.equal(updated.published_at, null);
    const now = await edit(db, { ...j, revision: 2 }, { scheduled_at: null }, null, '7');
    assert.equal(now.status, 'active');
    assert.ok(now.published_at);
  } finally {
    await db.close();
  }
});
test('PostgreSQL own-profile deletion atomically removes personal records, closes jobs, cancels scheduling and queues photo cleanup', async () => {
  const db = await database();
  try {
    const j = await job(db, {
      status: 'scheduled',
      scheduled_at: new Date(Date.now() + 3600000).toISOString(),
      contact_phone: '0501234567',
      contact_email: 'a@example.com',
    });
    await db.query('insert into job_seeker_preferences values($1)', [owner]);
    await db.query('insert into job_agent_messages values($1)', [owner]);
    assert.equal(
      (await query(db, 'select delete_own_job_profile($1,$2) result', [owner, 'wrong']))[0].result,
      false,
    );
    assert.equal(
      (await query(db, 'select delete_own_job_profile($1,$2) result', [owner, 'wa1']))[0].result,
      true,
    );
    for (const table of ['employer_profiles', 'job_seeker_preferences', 'job_agent_messages'])
      assert.equal((await query(db, `select * from ${table}`)).length, 0);
    assert.equal((await query(db, 'select * from job_agent_profiles')).length, 1);
    const closed = (await query(db, 'select * from jobs where id=$1', [j.id]))[0];
    assert.equal(closed.status, 'closed');
    assert.equal(closed.scheduled_at, null);
    assert.equal(closed.contact_phone, null);
    assert.equal(closed.contact_email, null);
    assert.equal(closed.metadata.employer_profile_id, undefined);
    assert.equal((await query(db, 'select * from job_media_cleanup'))[0].path, 'owner/photo.jpg');
    assert.equal(
      (await query(db, 'select delete_own_job_profile($1,$2) result', [owner, 'wa1']))[0].result,
      false,
    );
  } finally {
    await db.close();
  }
});
test('PostgreSQL lifecycle RPCs are service-only; moderators can receive explicit edit permission', async () => {
  const db = await database();
  try {
    await db.exec(
      "insert into telegram_staff values(array['edit','create']); insert into telegram_staff_invites values(array['edit']); set role anon;",
    );
    await assert.rejects(query(db, 'select run_vacancy_lifecycle()'), (e) => e.code === '42501');
    await assert.rejects(
      query(db, 'select delete_own_job_profile($1,$2)', [owner, 'wa1']),
      (e) => e.code === '42501',
    );
    await db.exec('reset role; set role service_role');
    assert.ok((await query(db, 'select run_vacancy_lifecycle() result'))[0].result);
  } finally {
    await db.close();
  }
});

test('database cron gate stays disabled until backend activation, service-only activation is idempotent', async () => {
  const db = await database();
  try {
    assert.equal(
      (await query(db, 'select enabled from vacancy_lifecycle_settings'))[0].enabled,
      false,
    );
    await job(db, { created_at: '2020-01-01' });
    await query(
      db,
      'select run_vacancy_lifecycle() from vacancy_lifecycle_settings where id=true and enabled',
    );
    assert.equal((await query(db, 'select count(*)::int n from jobs'))[0].n, 1);
    await db.exec('set role anon');
    await assert.rejects(
      query(db, 'select activate_vacancy_lifecycle()'),
      (e) => e.code === '42501',
    );
    await db.exec('reset role; set role service_role');
    await query(db, 'select activate_vacancy_lifecycle()');
    await query(db, 'select activate_vacancy_lifecycle()');
    assert.equal(
      (await query(db, 'select enabled from vacancy_lifecycle_settings'))[0].enabled,
      true,
    );
  } finally {
    await db.close();
  }
});
