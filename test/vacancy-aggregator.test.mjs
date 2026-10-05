import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  BossAdapter,
  HelloJobAdapter,
  configuredAdapters,
  AuthorizedRssAdapter,
} from '../dist/vacancy-aggregator/adapters.js';
import { parseRss, parseJobPosting } from '../dist/vacancy-aggregator/parsers.js';
import {
  VacancyNormalizer,
  canonicalUrl,
  salary,
  workMode,
} from '../dist/vacancy-aggregator/normalization.js';
import { VacancyCollector } from '../dist/vacancy-aggregator/collector.js';
import {
  CollectorRepository,
  DisabledNotificationPlanner,
} from '../dist/vacancy-aggregator/repository.js';
import {
  SourceAccessError,
  bounded,
  privateAddress,
  fetchFeed,
} from '../dist/vacancy-aggregator/http.js';
import { runCollector } from '../dist/vacancy-aggregator/main.js';
import { fixture, seeker, last } from './helpers/job-agent-fixture.mjs';
const signal = () => new AbortController().signal;
const rss = await readFile(
  new URL('./fixtures/collector/partner-rss.xml', import.meta.url),
  'utf8',
);
const html = await readFile(
  new URL('./fixtures/collector/hello-jobposting.html', import.meta.url),
  'utf8',
);
const raw = (overrides = {}) => ({
  external_id: '100',
  source_url: 'https://partner.example/jobs/100',
  title: 'Frontend developer',
  company: 'Mock Tech',
  location: 'Baki',
  work_mode: 'office',
  salary: '2000–3500 AZN',
  description: 'React TypeScript',
  expires_at: '2099-11-05',
  ...overrides,
});
const normalized = async (overrides = {}) =>
  new VacancyNormalizer().normalize('partner', raw(overrides), signal());
const source = (records, extra = {}) => ({
  source: 'partner',
  enabled: true,
  collect: async () => records,
  ...extra,
});

test('Boss prepared RSS parser extracts deterministic fields; adapter remains disabled', async () => {
  const adapter = new BossAdapter();
  const items = adapter.parse(rss);
  assert.equal(items.length, 1);
  assert.equal(items[0].external_id, 'az-100');
  assert.equal(items[0].company, 'Mock Tech MMC');
  const job = await new VacancyNormalizer().normalize(adapter.source, items[0], signal());
  assert.equal(job.salary_min, 2000);
  assert.equal(job.salary_max, 3500);
  assert.equal(job.work_mode, 'hybrid');
  assert.deepEqual(job.skills, ['react', 'typescript', 'git']);
  assert.equal(job.status, 'pending');
  assert.equal(adapter.enabled, false);
  assert.deepEqual(await adapter.collect(), []);
});
test('HelloJob offline JobPosting parser supports structured salary/address/requirements', async () => {
  const adapter = new HelloJobAdapter();
  const items = adapter.parse(html);
  assert.equal(adapter.enabled, false);
  const job = await new VacancyNormalizer().normalize(adapter.source, items[0], signal());
  assert.equal(job.company, 'Mock Company');
  assert.equal(job.location, 'Bakı, Nərimanov');
  assert.equal(job.work_mode, 'remote');
  assert.equal(job.salary_min, 1500);
  assert.equal(job.requirements, '2 il təcrübə');
  assert.equal(job.source_url, 'https://www.hellojob.az/vakansiya/synthetic-fixture-1');
});
test('RSS/Atom parsing validates XML, rejects entities and tolerates empty feed', () => {
  assert.deepEqual(parseRss('<rss><channel/></rss>'), []);
  assert.throws(() => parseRss('<!DOCTYPE x [<!ENTITY boom SYSTEM "file:///etc/passwd">]><rss/>'));
  assert.throws(() => parseRss('<rss><bad></rss>'));
  const atom = parseRss(
    '<feed><entry><id>1</id><title>Engineer</title><link href="https://partner.example/jobs/1"/><published>2026-10-05</published></entry></feed>',
  );
  assert.equal(atom[0].source_url, 'https://partner.example/jobs/1');
});
test('JobPosting graph supports arrays; invalid/unstructured/foreign content fails closed', () => {
  assert.throws(() => parseJobPosting('<html>No markup</html>'));
  assert.throws(() => parseJobPosting('<script type="application/ld+json">bad</script>'));
  assert.throws(() => parseJobPosting(html.replace('"AZ"', '"US"')));
  const graph = html.replace(
    '"@context":"https://schema.org","@type":"JobPosting"',
    '"@type":["Thing","JobPosting"]',
  );
  assert.equal(parseJobPosting(graph).length, 1);
});
test('canonical identity removes tracking/hash, retains semantic query and stable URL fallback', async () => {
  const a = await normalized({
    external_id: undefined,
    source_url: 'https://partner.example/jobs/100/?utm_medium=a#top',
  });
  const b = await normalized({ external_id: undefined });
  assert.equal(a.external_id, b.external_id);
  assert.equal(
    canonicalUrl('https://partner.example/jobs?id=1&utm_source=a'),
    'https://partner.example/jobs?id=1',
  );
  assert.throws(() => canonicalUrl('javascript:alert(1)'));
  assert.throws(() => canonicalUrl('https://user:pass@partner.example/'));
});
test('salary normalization handles fixed/negotiable/range/currency and rejects bad amounts', () => {
  assert.deepEqual(salary(raw({ salary: '2500,50 AZN' })), [2500.5, 2500.5, 'AZN']);
  assert.deepEqual(salary(raw({ salary: 'Razılaşma ilə' })), [null, null, 'AZN']);
  assert.deepEqual(salary(raw({ salary: '2000 USD' })), [2000, 2000, 'USD']);
  assert.deepEqual(salary(raw({ salary_min: 15, salary_max: 20, salary_unit: 'HOUR' })), [
    null,
    null,
    'AZN',
  ]);
  assert.throws(() => salary(raw({ salary_min: 3000, salary_max: 1000 })));
  assert.throws(() => salary(raw({ salary_min: -1 })));
  assert.equal(workMode('FULL_TIME'), null);
});
test('unknown source expiry is bounded; expired/closed feeds cannot be approved via pending flow', async () => {
  const old = await normalized({ published_at: '2020-01-01', expires_at: undefined });
  assert.equal(old.status, 'closed');
  const unknown = await normalized({ expires_at: undefined });
  assert.equal(unknown.status, 'pending');
  assert.ok(unknown.expires_at);
  assert.equal((await normalized({ closed: true })).status, 'closed');
});
test('optional semantic provider enriches only missing fields; errors and timeouts fall back', async () => {
  let called = 0;
  const provider = {
    enrich: async () => {
      called++;
      return { category: 'Texnologiya', work_mode: 'hybrid', skills: ['React'] };
    },
  };
  const normalizer = new VacancyNormalizer(provider);
  const complete = raw({ category: 'Texnologiya', skills: ['React'] });
  await normalizer.normalize('partner', complete, signal());
  assert.equal(called, 0);
  const result = await normalizer.normalize(
    'partner',
    raw({ category: undefined, work_mode: undefined }),
    signal(),
  );
  assert.equal(result.category, 'Texnologiya');
  assert.equal(result.work_mode, 'hybrid');
  const failed = await new VacancyNormalizer({
    enrich: async () => {
      throw new Error('AI outage');
    },
  }).normalize('partner', raw(), signal());
  assert.equal(failed.title, 'Frontend developer');
  const timed = await new VacancyNormalizer({ enrich: () => new Promise(() => {}) }, 5).normalize(
    'partner',
    raw(),
    signal(),
  );
  assert.equal(timed.salary_min, 2000);
});
test('idempotent Supabase upsert preserves approved/rejected decisions and metadata', async () => {
  const f = fixture();
  const repo = new CollectorRepository(f.client);
  const job = await normalized();
  const first = await repo.insert(job);
  assert.equal(first.inserted, true);
  assert.equal(f.tables.jobs[0].status, 'pending');
  assert.equal((await repo.insert(job)).inserted, false);
  assert.equal(f.tables.jobs.length, 1);
  await f.admin.approve(first.id);
  const published = f.tables.jobs[0].published_at;
  await repo.insert({ ...job, title: 'changed upstream' });
  assert.equal(f.tables.jobs[0].status, 'active');
  assert.equal(f.tables.jobs[0].published_at, published);
  assert.equal(f.tables.jobs[0].title, job.title);
  f.tables.jobs[0].status = 'rejected';
  f.tables.jobs[0].metadata.moderation_reason = 'Rejected';
  await repo.insert(job);
  assert.equal(f.tables.jobs[0].metadata.moderation_reason, 'Rejected');
});
test('canonical URL uniqueness catches different external IDs and tracking aliases', async () => {
  const f = fixture(),
    repo = new CollectorRepository(f.client);
  await repo.insert(await normalized());
  const result = await repo.insert(
    await normalized({
      external_id: 'changed-id',
      source_url: 'https://partner.example/jobs/100/?utm_source=rss',
    }),
  );
  assert.equal(result.inserted, false);
  assert.equal(result.id, 1);
  assert.equal(f.tables.jobs.length, 1);
});
test('source category maps to existing active category without creating a parallel catalog', async () => {
  const f = fixture();
  f.tables.job_categories.push({ id: 7, name: 'Texnologiya', is_active: true });
  await new CollectorRepository(f.client).insert(await normalized({ category: 'Texnologiya' }));
  assert.equal(f.tables.jobs[0].category_id, 7);
  assert.equal(f.tables.jobs[0].metadata.category, 'Texnologiya');
});
test('source outage/access refusal/invalid record isolation still collects healthy sources', async () => {
  const f = fixture(),
    repo = new CollectorRepository(f.client);
  let retry = 0,
    denied = 0;
  const sources = [
    new BossAdapter(),
    source([], {
      source: 'broken',
      collect: async () => {
        retry++;
        throw new Error('offline');
      },
    }),
    source([], {
      source: 'denied',
      collect: async () => {
        denied++;
        throw new SourceAccessError('403');
      },
    }),
    source([raw({ title: '' }), raw()]),
  ];
  const reports = await new VacancyCollector(sources, new VacancyNormalizer(), repo).run();
  assert.equal(reports[0].status, 'disabled');
  assert.equal(reports[1].status, 'failed');
  assert.equal(reports[2].status, 'failed');
  assert.equal(retry, 2);
  assert.equal(denied, 1);
  assert.equal(reports[3].inserted, 1);
  assert.equal(reports[3].invalid, 1);
});
test('source timeout bounded and subsequent source imports continue', async () => {
  const f = fixture();
  const reports = await new VacancyCollector(
    [source([], { source: 'hang', collect: () => new Promise(() => {}) }), source([raw()])],
    new VacancyNormalizer(),
    new CollectorRepository(f.client),
    5,
  ).run();
  assert.equal(reports[0].status, 'failed');
  assert.equal(reports[1].inserted, 1);
});
test('admin notifications are once per inserted pending job and failure does not drop it', async () => {
  const f = fixture();
  let notices = 0;
  const collector = new VacancyCollector(
    [source([raw()])],
    new VacancyNormalizer(),
    new CollectorRepository(f.client),
    30,
    async () => {
      notices++;
      throw new Error('Telegram down');
    },
  );
  await collector.run();
  await collector.run();
  assert.equal(notices, 1);
  assert.equal(f.tables.jobs.length, 1);
});
test('collected pending is hidden, approval includes it in WhatsApp all/matching/detail with source', async () => {
  const f = fixture();
  await seeker(f);
  const repo = new CollectorRepository(f.client);
  const result = await repo.insert(await normalized());
  await f.action('job:all');
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    0,
  );
  await f.admin.approve(result.id);
  await f.action('job:all');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:detail:all:0:1'));
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:detail:matches:0:1'));
  await f.action('job:detail:matches:0:1');
  assert.match(last(f, 'sendText').args[1], /https:\/\/partner.example\/jobs\/100/);
  assert.match(last(f, 'sendText').args[1], /Mənbə: partner/);
});
test('all sources share matching and five-row next/back pagination', async () => {
  const f = fixture();
  await seeker(f);
  const repo = new CollectorRepository(f.client);
  for (let i = 1; i <= 12; i++) {
    const result = await repo.insert(
      await normalized({ external_id: String(i), source_url: `https://partner.example/jobs/${i}` }),
    );
    await f.admin.approve(result.id);
  }
  await f.action('job:matches');
  const first = last(f, 'sendJobList').args[2];
  assert.equal(first.filter((r) => r.id.startsWith('job:detail')).length, 5);
  await f.action('job:page:matches:1');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:matches:0'));
  await f.action('job:page:matches:0');
  assert.deepEqual(last(f, 'sendJobList').args[2], first);
});
test('persisted profile skills filter normalized imported jobs, optional when absent', async () => {
  const f = fixture();
  await seeker(f);
  const repo = new CollectorRepository(f.client);
  const result = await repo.insert(await normalized());
  await f.admin.approve(result.id);
  f.tables.job_seeker_preferences[0].metadata = { skills: ['React'] };
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
  f.tables.job_seeker_preferences[0].metadata = { skills: ['Python'] };
  await f.action('job:matches');
  assert.equal(
    last(f, 'sendJobList').args[2].filter((r) => r.id.startsWith('job:detail')).length,
    0,
  );
  await f.action('job:all');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('disabled notification intents deduplicate across planner restart and match persisted opt-ins', async () => {
  const f = fixture();
  await seeker(f);
  f.tables.job_seeker_preferences[0].notifications_enabled = true;
  const result = await new CollectorRepository(f.client).insert(await normalized());
  let planner = new DisabledNotificationPlanner(f.client);
  assert.equal(await planner.plan('p1', result.id), false);
  await f.admin.approve(result.id);
  const before = f.sent.length;
  assert.equal(await planner.planMatches(result.id), 1);
  assert.equal(f.sent.length, before);
  planner = new DisabledNotificationPlanner(f.client);
  assert.equal(await planner.planMatches(result.id), 0);
  assert.equal(f.tables.vacancy_notification_intents.length, 1);
  assert.equal(f.tables.vacancy_notification_intents[0].status, 'disabled');
  f.tables.job_seeker_preferences[0].notifications_enabled = false;
  assert.equal(await planner.plan('p1', result.id), false);
});
test('unmatched, expired and synthetic Telegram profiles never receive planned intents', async () => {
  const f = fixture();
  await seeker(f);
  const pref = f.tables.job_seeker_preferences[0];
  pref.notifications_enabled = true;
  pref.salary_min = 5000;
  const result = await new CollectorRepository(f.client).insert(await normalized());
  await f.admin.approve(result.id);
  const planner = new DisabledNotificationPlanner(f.client);
  assert.equal(await planner.planMatches(result.id), 0);
  pref.salary_min = 1000;
  f.tables.jobs[0].expires_at = '2020-01-01';
  assert.equal(await planner.plan('p1', result.id), false);
});
test('disabled default CLI performs no fetch, DB writes or notifications; unsafe source activation rejected', async () => {
  const adapters = configuredAdapters({});
  assert.ok(adapters.every((a) => !a.enabled));
  await runCollector({});
  assert.throws(() => configuredAdapters({ COLLECTOR_RSS_URL: 'https://partner.example/feed' }));
  assert.throws(
    () => new AuthorizedRssAdapter('boss_az', 'https://boss.az/feed', 'boss.az', 'agreement'),
  );
  await assert.rejects(
    () =>
      runCollector({
        COLLECTOR_RSS_URL: 'https://partner.example/feed',
        COLLECTOR_RSS_HOST: 'partner.example',
        COLLECTOR_RSS_SOURCE: 'partner',
        COLLECTOR_RSS_PERMISSION: 'test',
      }),
    /disabled/,
  );
});
test('HTTP protection rejects disallowed/private URL without network and bounded operations stop', async () => {
  await assert.rejects(
    () => fetchFeed('https://127.0.0.1/feed', 'wrong-host', signal()),
    SourceAccessError,
  );
  assert.ok(privateAddress('127.0.0.1'));
  assert.ok(privateAddress('10.1.2.3'));
  assert.ok(privateAddress('::1'));
  assert.equal(privateAddress('8.8.8.8'), false);
  await assert.rejects(() => bounded(() => new Promise(() => {}), 5), /timeout/);
});
