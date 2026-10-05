import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const migration = await readFile(
  new URL(
    '../supabase/migrations/20261005135413_business_registration_moderation.sql',
    import.meta.url,
  ),
  'utf8',
);
const id1 = '11111111-1111-4111-8111-111111111111',
  id2 = '22222222-2222-4222-8222-222222222222';
async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table public.jobs(id bigint generated always as identity primary key,source text,status text,metadata jsonb default '{}'::jsonb);
 create schema storage;
 create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table public.job_agent_profiles(id uuid primary key,phone text,wa_id text);
 create table public.employer_profiles(profile_id uuid primary key references public.job_agent_profiles(id),email text,verified boolean default false);
 grant all on public.job_agent_profiles,public.employer_profiles to anon,authenticated;
 grant all on public.job_agent_profiles,public.employer_profiles,public.jobs to service_role;
 grant all on all sequences in schema public to service_role;
 insert into public.job_agent_profiles values ('${id1}','994501234567','994501234567'),('${id2}','994551234567','994551234567');
 insert into public.employer_profiles values ('${id1}','HR@EXAMPLE.COM',false);`);
  return db;
}
test('migration preserves users, privately stores photos and enforces unique normalized contacts through PostgreSQL', async () => {
  const db = await database();
  try {
    await db.exec(migration);
    const q = async (sql, params) => (await db.query(sql, params)).rows;
    assert.equal((await q('select count(*)::int n from public.job_agent_profiles'))[0].n, 2);
    const legacy = (await q('select * from public.employer_profiles'))[0];
    assert.equal(legacy.registration_status, 'draft');
    assert.equal(legacy.verified, false);
    assert.equal(
      (await q('select contact_email from public.job_agent_profiles where id=$1', [id1]))[0]
        .contact_email,
      'hr@example.com',
    );
    assert.equal(
      (
        await q("select public,file_size_limit from storage.buckets where id='job-business-photos'")
      )[0].public,
      false,
    );
    await db.exec('set role service_role');
    await assert.rejects(
      q(
        "insert into public.jobs(source,status,metadata) values('whatsapp','draft',jsonb_build_object('employer_profile_id',$1::text))",
        [id1],
      ),
      (e) => e.code === '23514',
    );
    await q("insert into public.jobs(source,status) values('telegram','active')");
    await q('select public.claim_job_profile_contact($1,$2,$3)', [
      id1,
      'HR@example.com',
      '050 123 45 67',
    ]);
    await assert.rejects(
      q('select public.claim_job_profile_contact($1,$2,$3)', [id2, 'hr@example.com', null]),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      q('select public.claim_job_profile_contact($1,$2,$3)', [id2, null, '00994501234567']),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      q('select public.claim_job_profile_contact($1,$2,$3)', [id1, null, '+994551234567']),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      q('select public.claim_job_profile_contact($1,$2,$3)', [id1, null, 'bad']),
      (e) => e.code === '22023',
    );
    await q('select public.claim_job_profile_contact($1,$2,$3)', [
      id2,
      'seeker@example.com',
      '+994551234567',
    ]);
    await assert.rejects(
      q('update public.job_agent_profiles set contact_email=$1 where id=$2', [
        'HR@EXAMPLE.COM',
        id2,
      ]),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      q('update public.job_agent_profiles set contact_phone=$1 where id=$2', ['0501234567', id2]),
      (e) => e.code === '23505',
    );
    await q(
      "update public.employer_profiles set registration_status='approved',verified=true,registration_token='abcdefabcdef',voen_verified_at=now(),registry_reference='fixture',photo_path='private.jpg' where profile_id=$1",
      [id1],
    );
    await q(
      "insert into public.jobs(source,status,metadata) values('whatsapp','draft',jsonb_build_object('employer_profile_id',$1::text))",
      [id1],
    );
    await q('select public.claim_job_profile_contact($1,$2,$3)', [id1, 'new@example.com', null]);
    await assert.rejects(
      q("update public.jobs set status='pending' where source='whatsapp'"),
      (e) => e.code === '23514',
    );
    const changed = (
      await q('select * from public.employer_profiles where profile_id=$1', [id1])
    )[0];
    assert.equal(changed.registration_status, 'draft');
    assert.equal(changed.registration_token, null);
    assert.equal(changed.verified, false);
    assert.equal(changed.email, 'new@example.com');
    await q(
      "update public.employer_profiles set registration_status='approved',verified=true where profile_id=$1",
      [id1],
    );
    await q('select public.claim_job_profile_contact($1,$2,$3)', [id1, null, '+994701234567']);
    assert.equal(
      (await q('select verified from public.employer_profiles where profile_id=$1', [id1]))[0]
        .verified,
      false,
    );
    await db.exec('reset role');
    assert.equal(
      (
        await q(
          "select has_function_privilege('anon','public.claim_job_profile_contact(uuid,text,text)','EXECUTE') allowed",
        )
      )[0].allowed,
      false,
    );
    assert.equal(
      (await q("select prosecdef from pg_proc where proname='claim_job_profile_contact'"))[0]
        .prosecdef,
      false,
    );
    for (const table of ['job_agent_profiles', 'employer_profiles']) {
      assert.equal(
        (await q('select relrowsecurity from pg_class where relname=$1', [table]))[0]
          .relrowsecurity,
        true,
      );
      assert.equal(
        (await q(`select has_table_privilege('anon','public.${table}','SELECT') allowed`))[0]
          .allowed,
        false,
      );
      assert.equal(
        (
          await q(`select has_table_privilege('authenticated','public.${table}','UPDATE') allowed`)
        )[0].allowed,
        false,
      );
    }
    await db.exec('set role anon');
    await assert.rejects(
      q('select public.claim_job_profile_contact($1,$2,$3)', [id1, 'a@example.com', null]),
      (e) => e.code === '42501',
    );
  } finally {
    await db.close();
  }
});
test('duplicate legacy emails abort migration without dropping data or choosing a winner', async () => {
  const db = await database();
  try {
    await db.query('insert into public.employer_profiles values($1,$2,false)', [
      id2,
      ' hr@example.com ',
    ]);
    await assert.rejects(db.exec(migration), (e) => e.code === '23505');
    await db.exec('rollback');
    assert.equal(
      (await db.query('select count(*)::int n from public.employer_profiles')).rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from information_schema.columns where table_name='job_agent_profiles' and column_name='contact_email'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
