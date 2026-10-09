import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const sql = await readFile(
  new URL(
    '../supabase/migrations/20261009101207_registration_free_browse_analytics.sql',
    import.meta.url,
  ),
  'utf8',
);
test('browse statistics count distinct guests in Baku calendar periods, exclude employers, preserve totals for deleted jobs and restrict public access', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table job_agent_profiles(id uuid primary key,wa_id text,role text);
 create table jobs(id bigint primary key,title text);
 create table job_categories(id bigint primary key,name text);
 insert into job_agent_profiles values ('00000000-0000-4000-8000-000000000001','guest',null),('00000000-0000-4000-8000-000000000002','employer','employer');
 insert into jobs values(1,'Developer'); insert into job_categories values(1,'IT');
 grant select on job_agent_profiles,jobs,job_categories to service_role;`);
    await db.exec(sql);
    await db.exec(`insert into vacancy_browse_events(profile_id,kind,job_id,category_id,created_at) values
 ('00000000-0000-4000-8000-000000000001','list',null,1,'2026-10-08T20:01:00Z'),
 ('00000000-0000-4000-8000-000000000001','detail',1,1,'2026-10-08T20:02:00Z'),
 ('00000000-0000-4000-8000-000000000002','detail',1,1,'2026-10-08T20:03:00Z');`);
    await db.exec('set role service_role');
    const result = (await db.query("select vacancy_browse_statistics('2026-10-09T10:00:00Z') as s"))
      .rows[0].s;
    assert.equal(result.visitors, 1);
    assert.equal(result.activeDay, 1);
    assert.equal(result.detailViews, 1);
    assert.equal(result.topJobs[0].views, 1);
    assert.equal(result.topCategories[0].selections, 1);
    await db.exec('reset role; delete from jobs where id=1; set role service_role;');
    assert.equal(
      (await db.query("select vacancy_browse_statistics('2026-10-09T10:00:00Z') as s")).rows[0].s
        .detailViews,
      1,
    );
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from vacancy_browse_events'), /permission denied/);
    await assert.rejects(db.query('select vacancy_browse_statistics()'), /permission denied/);
  } finally {
    await db.close();
  }
});
