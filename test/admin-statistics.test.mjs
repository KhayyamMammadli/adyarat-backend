import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statisticsPeriod } from '../dist/telegram/admin-statistics.js';
import { JobAdminService } from '../dist/job-agent/job-admin.service.js';
test('Baku day and Monday calendar week boundaries cross UTC and year correctly', () => {
  const now = new Date('2026-01-04T21:00:00Z');
  assert.deepEqual(statisticsPeriod('day', now), {
    from: '2026-01-04T20:00:00.000Z',
    to: now.toISOString(),
  });
  assert.equal(statisticsPeriod('week', now).from, '2026-01-04T20:00:00.000Z');
  assert.equal(
    statisticsPeriod('week', new Date('2026-01-04T19:00:00Z')).from,
    '2025-12-28T20:00:00.000Z',
  );
});
test('statistics use exact head counts, persisted roles, expiry and date bounds; listing uses pagination', async () => {
  const calls = [];
  let fail = false;
  const client = {
    from(table) {
      const ops = [];
      const q = {
        select(...a) {
          ops.push(['select', ...a]);
          return q;
        },
        eq(...a) {
          ops.push(['eq', ...a]);
          return q;
        },
        or(...a) {
          ops.push(['or', ...a]);
          return q;
        },
        gte(...a) {
          ops.push(['gte', ...a]);
          return q;
        },
        lte(...a) {
          ops.push(['lte', ...a]);
          return q;
        },
        order(...a) {
          ops.push(['order', ...a]);
          return q;
        },
        range(...a) {
          ops.push(['range', ...a]);
          return q;
        },
        then(resolve) {
          calls.push({ table, ops });
          return Promise.resolve({
            count: 3,
            data: [{ id: 1 }],
            error: fail ? new Error('DB failed') : null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  const service = new JobAdminService({ client }, {});
  const now = new Date('2026-10-06T03:00:00Z');
  const result = await service.statistics(now);
  assert.equal(result.totalJobs, 3);
  assert.equal(calls.length, 8);
  assert(calls.every((c) => c.ops[0][2].head === true && c.ops[0][2].count === 'exact'));
  assert(
    calls.some((c) => c.ops.some((o) => o[0] === 'eq' && o[1] === 'role' && o[2] === 'employer')),
  );
  assert(
    calls.some((c) => c.ops.some((o) => o[0] === 'gte' && o[2] === '2026-10-05T20:00:00.000Z')),
  );
  await service.periodJobs('week', 2, now);
  assert.deepEqual(calls.at(-1).ops.at(-1), ['range', 10, 15]);
  fail = true;
  await assert.rejects(service.statistics(now), /DB failed/);
});
