import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const expected = [
  'Biznes / İdarəetmə / HR',
  'Daşınmaz Əmlak',
  'Elm / Təhsil / Təlim',
  'Hotel / Restoran / Kafe',
  'İncəsənət / Yaradıcılıq',
  'İnformasiya Texnologiyaları',
  'İnşaat / Tikinti / Memarlıq',
  'İstehsalat / Zavod / Servis',
  'Kənd təsərrüfatı / Sənaye',
  'Maliyyə / Audit / Mühasib',
  'Marketinq / Sosial Media',
  'Mühafizə / Təhlükəsizlik',
  'Nəqliyyat / Texnika / Anbar',
  'Ofis / Sənədləşmə',
  'Pərakəndə Satıcılıq',
  'Satış və Müştəri Xidmətləri',
  'Səhiyyə / Tibb / Sağlamlıq',
  'Təchizat / Loqistika',
  'Digər ixtisassız fəhlə',
];
test('canonical labels match requested 19 categories and preserve IDs, slugs and vacancy references', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      'create table job_categories(id bigint generated always as identity primary key,name text unique,slug text unique,is_active boolean); create table jobs(id int primary key,category_id bigint references job_categories(id));',
    );
    await db.exec(
      await readFile(
        new URL('../supabase/migrations/20261005215209_backup_job_categories.sql', import.meta.url),
        'utf8',
      ),
    );
    const before = (await db.query('select * from job_categories order by id')).rows;
    await db.query("insert into jobs values(1,(select id from job_categories where name='Digər'))");
    const migration = await readFile(
      new URL(
        '../supabase/migrations/20261007113842_canonical_vacancy_categories.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await db.exec(migration);
    await db.exec(migration);
    const after = (await db.query('select * from job_categories order by id')).rows;
    assert.deepEqual(after.map((c) => c.name).sort(), expected.sort());
    assert.deepEqual(
      after.map((c) => [c.id, c.slug, c.is_active]),
      before.map((c) => [c.id, c.slug, c.is_active]),
    );
    assert.equal(
      (await db.query('select c.name from jobs j join job_categories c on c.id=j.category_id'))
        .rows[0].name,
      'Digər ixtisassız fəhlə',
    );
  } finally {
    await db.close();
  }
});
