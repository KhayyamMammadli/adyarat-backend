import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  employerDraft,
  approvedEmployer,
  seeker,
  seedJobs,
  last,
} from './helpers/job-agent-fixture.mjs';
import { JobAgentService } from '../dist/job-agent/job-agent.service.js';
import { VacancyManagementService } from '../dist/job-agent/vacancy-management.service.js';
import { VacancyLifecycleWorker } from '../dist/job-agent/vacancy-lifecycle.worker.js';
import { TelegramVacancyManagementService } from '../dist/telegram/telegram-vacancy-management.service.js';
import { TelegramAdminStateService } from '../dist/telegram/telegram-admin-state.service.js';
import { TelegramJobAdminService } from '../dist/telegram/telegram-job-admin.service.js';
import {
  parsePublicationTime,
  RETENTION_MS,
  editValue,
} from '../dist/job-agent/vacancy-lifecycle.js';
import { moderationButtons } from '../dist/telegram/job-message.js';
import { requiredPermission } from '../dist/telegram/staff-permissions.js';
function managed() {
  const f = fixture(),
    management = new VacancyManagementService({ client: f.client }, f.whatsapp, {
      sendMessage: async (...args) => f.notices.push(args),
    });
  const service = new JobAgentService(
    { client: f.client },
    f.whatsapp,
    { sendMessage: async () => {} },
    f.businesses,
    management,
  );
  return {
    ...f,
    management,
    action: (id) => service.handleInteractive('wa1', id),
    text: (text) => service.handleText('wa1', text),
    service,
  };
}
function futureInput(hours = 24) {
  const d = new Date(Date.now() + (hours + 4) * 3600000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function telegramFixture() {
  const f = fixture(),
    messages = [];
  const telegram = {
    sendTo: async (chatId, text, markup) => {
      messages.push({ chatId, text, markup });
      return { message_id: messages.length };
    },
    clearButtons: async () => {},
  };
  const states = new TelegramAdminStateService({ client: f.client });
  const actor = {
    chatId: 7,
    userId: 7,
    group: false,
    permissions: ['edit', 'create', 'approve', 'pending'],
    role: 'admin',
  };
  let permissions = actor.permissions,
    update = 0;
  const staff = { resolve: async () => ({ role: 'admin', permissions }) };
  const edit = new TelegramVacancyManagementService({ client: f.client }, staff, states, telegram);
  const admin = new TelegramJobAdminService(f.admin, states, telegram, f.businesses);
  const send = async (data, text, location) => {
    const u = {
      update_id: ++update,
      ...(data
        ? {
            callback_query: { data, from: { id: 7 }, message: { message_id: 99, chat: { id: 7 } } },
          }
        : { message: { text, location, chat: { id: 7 }, from: { id: 7 } } }),
    };
    if (!(await edit.handle(actor, u))) return admin.handle(actor, u);
  };
  return {
    ...f,
    states,
    actor,
    edit,
    admin,
    messages,
    send,
    session: async () => (await states.load(actor)).session,
    revoke: () => {
      permissions = [];
    },
  };
}
test('publication time validates real dates, future bounds and Baku timezone', () => {
  const now = Date.parse('2026-07-09T00:00Z');
  assert.equal(
    parsePublicationTime('10.07.2026 16:00', now + RETENTION_MS, now),
    '2026-07-10T12:00:00.000Z',
  );
  for (const v of [
    '31.02.2026 12:00',
    '10.07.2026 24:00',
    '09.07.2026 04:00',
    '10.08.2026 16:00',
    'tomorrow',
  ])
    assert.equal(parsePublicationTime(v, now + RETENTION_MS, now), undefined);
  assert.equal(editValue('contact_email', 'bad', {}), undefined);
  assert.equal(editValue('salary', '2000-1000', {}), undefined);
});
test('WhatsApp creation schedule waits for approval and is absent from all/matching; immediate approval stays visible', async () => {
  const f = managed(),
    j = await employerDraft(f);
  await f.action('job:schedule:later');
  assert.equal(f.state(), 'employer_schedule');
  await f.text('31.02.2027 12:00');
  assert.equal(f.state(), 'employer_schedule');
  await f.text(futureInput());
  assert.equal(f.state(), 'employer_confirm');
  assert.ok(j.scheduled_at);
  await f.action(`job:confirm:${j.id}`);
  assert.equal(j.status, 'pending');
  await f.admin.approve(j.id);
  assert.equal(j.status, 'scheduled');
  assert.ok(j.approved_at);
  assert.equal(j.published_at, null);
  await f.action('job:all');
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
  await seeker(f);
  await f.action('job:matches');
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('WhatsApp immediate switch clears selected schedule and moderation revision rejects stale buttons', async () => {
  const f = managed(),
    j = await employerDraft(f);
  await f.action('job:schedule:later');
  await f.text(futureInput());
  await f.action('job:schedule:now');
  assert.equal(j.scheduled_at, null);
  await f.action(`job:confirm:${j.id}`);
  j.revision = 2;
  await assert.rejects(f.admin.approve(j.id, 1));
  await assert.rejects(f.admin.reject(j.id, 'reason', 1));
  assert.equal(j.status, 'pending');
  await f.admin.approve(j.id, 2);
  assert.equal(j.status, 'active');
  assert.deepEqual(
    moderationButtons(j.id, 2).inline_keyboard[0].map((b) => b.callback_data),
    ['tg:approve:1:2', 'tg:reject:1:2'],
  );
});
test('WhatsApp own-vacancy editing drafts are isolated, paginated, validated and saved through atomic revision RPC', async () => {
  const f = managed();
  await approvedEmployer(f);
  seedJobs(f, 12);
  const p = f.tables.job_agent_profiles[0];
  for (const j of f.tables.jobs) {
    j.metadata = { employer_profile_id: p.id };
    j.created_at = new Date().toISOString();
    j.latitude = 40.4;
    j.longitude = 49.8;
  }
  f.tables.jobs.at(-1).metadata = { employer_profile_id: 'other' };
  await f.action('job:mine');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:mine:1'));
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id === 'job:edit:12'));
  await f.action('job:edit:12');
  assert.match(last(f, 'sendText').args[1], /tapılmadı/);
  await f.action('job:edit:1');
  const token = p.browse_filters.management.token;
  assert.ok(last(f, 'sendJobList').args[2].length <= 10);
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:menu'));
  await f.action(`job:manage:${token}:title`);
  await f.text('Updated');
  assert.equal(f.tables.jobs[0].title, 'Frontend 1');
  let rpc;
  f.client.rpc = async (name, args) => {
    rpc = { name, args };
    return {
      data: { ...f.tables.jobs[0], ...args.p_patch, id: 1, revision: 2, status: 'pending' },
      error: null,
    };
  };
  await f.action(`job:manage:${token}:save`);
  assert.equal(rpc.name, 'save_vacancy_revision');
  assert.equal(rpc.args.p_profile, p.id);
  assert.equal(rpc.args.p_patch.title, 'Updated');
  assert.equal(f.state(), 'ready');
  assert.equal(f.notices.length > 0, true);
  await f.action('job:edit:1');
  const old = p.browse_filters.management.token;
  await f.action('job:menu');
  await f.action(`job:manage:${old}:title`);
  assert.equal(f.state(), 'ready');
  assert.equal(p.browse_filters.management, undefined);
});
test('WhatsApp vacancy deletion asks for confirmation, keeps on No, and reports success on Yes', async () => {
  const f = managed();
  await approvedEmployer(f);
  const p = f.tables.job_agent_profiles[0];
  seedJobs(f, 1);
  Object.assign(f.tables.jobs[0], {
    title: 'Frontend developer',
    revision: 1,
    status: 'active',
    metadata: { employer_profile_id: p.id },
  });

  await f.action('job:edit:1');
  let token = p.browse_filters.management.token;
  await f.action(`job:manage:${token}:more`);
  assert.ok(last(f, 'sendJobList').args[2].some((row) => row.id === `job:manage:${token}:delete`));
  await f.action(`job:manage:${token}:delete`);
  assert.equal(f.tables.jobs.length, 1);
  assert.match(last(f, 'sendJobButtons').args[1], /Elanı silməyə əminsiniz/);
  const choices = last(f, 'sendJobButtons').args[2].map((button) => button.id);
  assert.ok(choices.includes(`job:manage:${token}:confirm_delete`));
  assert.ok(choices.includes(`job:manage:${token}:cancel_delete`));

  await f.action(`job:manage:${token}:cancel_delete`);
  assert.equal(f.tables.jobs.length, 1);
  assert.match(last(f, 'sendText').args[1], /Elanınız saxlanıldı/);

  await f.action('job:edit:1');
  token = p.browse_filters.management.token;
  await f.action(`job:manage:${token}:more`);
  await f.action(`job:manage:${token}:delete`);
  f.tables.jobs[0].revision = 2;
  await f.action(`job:manage:${token}:confirm_delete`);
  assert.equal(f.tables.jobs.length, 1);
  assert.match(last(f, 'sendText').args[1], /Elan tapılmadı və ya dəyişib/);

  await f.action('job:edit:1');
  token = p.browse_filters.management.token;
  await f.action(`job:manage:${token}:more`);
  await f.action(`job:manage:${token}:delete`);
  await f.action(`job:manage:${token}:confirm_delete`);
  assert.equal(f.tables.jobs.length, 0);
  assert.match(last(f, 'sendText').args[1], /Elanınız uğurla silindi/);
});
test('WhatsApp profile deletion requires fresh confirmation token and passes verified caller identity for both roles', async () => {
  for (const role of ['seeker', 'employer']) {
    const f = managed();
    await f.action('job:menu');
    const p = f.tables.job_agent_profiles[0];
    p.role = role;
    let calls = [];
    f.client.rpc = async (name, args) => {
      calls.push({ name, args });
      return { data: true, error: null };
    };
    await f.action('job:profile:delete');
    await f.action('job:profile:delete:wrong');
    assert.equal(calls.length, 0);
    const token = p.browse_filters.management.token;
    await f.action(`job:profile:delete:${token}`);
    assert.deepEqual(calls, [
      { name: 'delete_own_job_profile', args: { p_profile: p.id, p_wa_id: 'wa1' } },
    ]);
    assert.match(last(f, 'sendText').args[1], /Profil silindi/);
  }
});
test('Telegram admin can create scheduled vacancy with buttons and it remains hidden in shared WhatsApp listing', async () => {
  const f = telegramFixture();
  await f.send('tg:new');
  for (const text of ['Cafe', 'Cook', 'Experience required', 'Bakı']) await f.send(undefined, text);
  let s = await f.session();
  await f.send(`tg:create:${s.nonce}:mode:remote`);
  await f.send(undefined, '1000-2000');
  await f.send(undefined, 'hr@example.com');
  s = await f.session();
  assert.equal(s.step, 'confirm');
  assert.ok(
    f.messages
      .at(-1)
      .markup.inline_keyboard.flat()
      .some((b) => b.callback_data.endsWith(':plan')),
  );
  await f.send(`tg:create:${s.nonce}:plan`);
  await f.send(undefined, futureInput());
  s = await f.session();
  assert.equal(s.step, 'confirm');
  await f.send(`tg:create:${s.nonce}:publish`);
  const j = f.tables.jobs[0];
  assert.equal(j.status, 'scheduled');
  assert.ok(j.approved_at);
  assert.equal(j.metadata.telegram_admin_user_id, 7);
  await f.action('job:all');
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('Telegram own edit enforces fresh permissions, owner identity, GPS and revision on save', async () => {
  const f = telegramFixture();
  f.tables.jobs.push(
    {
      id: 1,
      title: 'Own',
      status: 'active',
      work_mode: 'remote',
      metadata: { telegram_admin_user_id: 7 },
      created_at: new Date().toISOString(),
    },
    { id: 2, title: 'Other', metadata: { telegram_admin_user_id: 8 } },
  );
  await f.send('editjob:open:2');
  assert.match(f.messages.at(-1).text, /tapılmadı/);
  await f.send('editjob:open:1');
  let s = await f.session();
  await f.send(`editjob:${s.nonce}:work_mode`);
  await f.send(`editjob:${s.nonce}:hybrid`);
  await f.send(`editjob:${s.nonce}:save`);
  assert.match(f.messages.at(-1).text, /lokasiya/);
  await f.send(`editjob:${s.nonce}:location_pin`);
  await f.send(undefined, undefined, { latitude: 40.4, longitude: 49.8 });
  s = await f.session();
  assert.equal(s.draft.job.latitude, 40.4);
  let rpc;
  f.client.rpc = async (name, args) => {
    rpc = { name, args };
    return { data: { ...s.draft.job, id: 1, status: 'active' }, error: null };
  };
  await f.send(`editjob:${s.nonce}:save`);
  assert.equal(rpc.args.p_telegram_user, '7');
  assert.equal(rpc.args.p_profile, null);
  assert.equal(rpc.args.p_revision, 1);
  assert.equal((await f.session()).kind, 'idle');
  f.revoke();
  await f.send('editjob:open:1');
  assert.match(f.messages.at(-1).text, /icazəniz yoxdur/);
  assert.equal(requiredPermission('tg:admin', '', 'edit'), undefined);
});
test('lifecycle worker retries SQL/storage failures and prevents overlapping ticks', async () => {
  let rpcCalls = 0,
    deleted = 0,
    fail = true,
    release;
  const client = {
    rpc: async () => {
      rpcCalls++;
      return { error: null };
    },
    from: () => ({
      select: () => ({ limit: async () => ({ data: [{ path: 'photo.jpg' }], error: null }) }),
      delete: () => ({
        eq: async () => {
          deleted++;
          return { error: null };
        },
      }),
    }),
    storage: {
      from: () => ({ remove: async () => ({ error: fail ? new Error('storage down') : null }) }),
    },
  };
  const w = new VacancyLifecycleWorker({ client });
  await w.tick();
  assert.equal(deleted, 0);
  fail = false;
  await w.tick();
  assert.equal(deleted, 1);
  client.rpc = () =>
    new Promise((r) => {
      release = r;
    });
  const first = w.tick();
  await w.tick();
  release({ error: new Error('database down') });
  await first;
  client.rpc = async () => {
    rpcCalls++;
    return { error: null };
  };
  await w.tick();
  assert.equal(deleted, 2);
  w.onApplicationShutdown();
});
