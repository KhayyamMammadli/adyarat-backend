import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { TelegramStaffService } from '../dist/telegram/telegram-staff.service.js';
import { TelegramStaffMenuService } from '../dist/telegram/telegram-staff-menu.service.js';
import { TelegramAdminStateService } from '../dist/telegram/telegram-admin-state.service.js';
import { TelegramJobAdminService } from '../dist/telegram/telegram-job-admin.service.js';
import { TelegramController } from '../dist/telegram/telegram.controller.js';
import { ALL_PERMISSIONS } from '../dist/telegram/staff-permissions.js';
import { fixture } from './helpers/job-agent-fixture.mjs';
function setup() {
  const f = fixture();
  f.tables.telegram_staff = [
    { user_id: '8', role: 'admin', permissions: ALL_PERMISSIONS, active: true },
  ];
  const config = new ConfigService({
    TELEGRAM_ADMIN_CHAT_ID: '7',
    TELEGRAM_ADMIN_USER_IDS: '8',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  });
  const staff = new TelegramStaffService({ client: f.client }, config);
  const states = new TelegramAdminStateService({ client: f.client });
  const messages = [];
  const telegram = {
    sendTo: async (chatId, text, markup) => {
      messages.push({ chatId, text, markup });
      return { message_id: messages.length };
    },
    answerCallback: async () => {},
    clearButtons: async () => {},
  };
  const menu = new TelegramStaffMenuService(staff, states, telegram);
  const jobs = new TelegramJobAdminService(f.admin, states, telegram, f.businesses, staff);
  const controller = new TelegramController(
    config,
    { handleCommand: async () => assert.fail('legacy bypass') },
    jobs,
    telegram,
    staff,
    menu,
  );
  let id = 0;
  const send = (user, text, callback = false) =>
    controller.webhook(
      callback
        ? {
            update_id: ++id,
            callback_query: {
              id: String(id),
              from: { id: user },
              message: { chat: { id: user, type: 'private' } },
              data: text,
            },
          }
        : {
            update_id: ++id,
            message: {
              message_id: id,
              from: { id: user },
              chat: { id: user, type: 'private' },
              text,
            },
          },
      'secret',
    );
  const actor = (user, role) => ({
    chatId: user,
    userId: user,
    group: false,
    role,
    permissions: ALL_PERMISSIONS,
  });
  return { ...f, staff, states, messages, send, actor };
}
test('superadmin and admin can manage moderators but admin cannot alter owner or admins; revocation overrides env', async () => {
  const f = setup();
  assert.equal((await f.staff.resolve(7)).role, 'superadmin');
  assert.equal((await f.staff.resolve(8)).role, 'admin');
  await f.staff.save(f.actor(8, 'admin'), '9', 'moderator', ['approve', 'pending']);
  assert.deepEqual((await f.staff.resolve(9)).permissions, ['approve', 'pending']);
  await assert.rejects(f.staff.save(f.actor(8, 'admin'), '7', 'moderator', []));
  await assert.rejects(f.staff.save(f.actor(8, 'admin'), '8', 'moderator', []));
  await assert.rejects(f.staff.save(f.actor(8, 'admin'), '10', 'admin', []));
  await assert.rejects(f.staff.save(f.actor(9, 'moderator'), '10', 'moderator', []));
  await f.staff.save(f.actor(7, 'superadmin'), '8', 'admin', [], false);
  assert.equal(await f.staff.resolve(8), undefined);
  await f.staff.save(f.actor(7, 'superadmin'), '8', 'admin', [], true);
  assert.equal((await f.staff.resolve(8)).role, 'admin');
});
test('multiple permission buttons persist only on Save, survive service restart, and revoke immediately', async () => {
  const f = setup();
  await f.send(8, 'staff:add:moderator', true);
  await f.send(8, '9');
  let state = await f.states.load(f.actor(8, 'admin'));
  const prefix = `staff:${state.session.nonce}:`;
  await f.send(8, prefix + 'approve', true);
  await f.send(8, prefix + 'pending', true);
  await f.send(8, prefix + 'statistics', true);
  await f.send(8, prefix + 'statistics', true); // deselect
  assert.equal(await f.staff.resolve(9), undefined);
  await f.send(8, prefix + 'save', true);
  assert.deepEqual((await f.staff.resolve(9)).permissions, ['approve', 'pending']);
  const restarted = new TelegramStaffService(
    { client: f.client },
    new ConfigService({ TELEGRAM_ADMIN_CHAT_ID: '7' }),
  );
  assert.deepEqual((await restarted.resolve(9)).permissions, ['approve', 'pending']);
  await f.send(8, 'staff:edit:9', true);
  state = await f.states.load(f.actor(8, 'admin'));
  await f.send(8, `staff:${state.session.nonce}:revoke`, true);
  assert.equal(await f.staff.resolve(9), undefined);
  const count = f.messages.length;
  await f.send(9, '/start');
  assert.equal(f.messages.length, count);
});
test('restricted moderator sees only allowed menu actions; forged callbacks and commands cannot mutate jobs or staff', async () => {
  const f = setup();
  await f.staff.save(f.actor(8, 'admin'), '9', 'moderator', ['pending', 'approve']);
  f.tables.jobs.push({ id: 1, status: 'pending', title: 'Test', company_name: 'Test' });
  await f.send(9, '/start');
  const panel = f.messages
    .at(-1)
    .markup.inline_keyboard.flat()
    .map((b) => b.callback_data);
  assert(panel.includes('tg:pending'));
  assert(!panel.includes('tg:new'));
  assert(!panel.includes('tg:stats'));
  assert(!panel.includes('staff:home'));
  await f.send(9, 'tg:reject:1', true);
  await f.send(9, '/reject 1 No');
  await f.send(9, 'tg:new', true);
  await f.send(9, 'staff:add:moderator', true);
  await f.send(9, '/stats');
  assert.equal(f.tables.jobs[0].status, 'pending');
  assert.equal(f.tables.telegram_staff.length, 2);
  await f.send(9, 'tg:approve:1', true);
  assert.equal(f.tables.jobs[0].status, 'active');
});
test('permissions are checked again during unfinished creation and rejection flows; home resets staff draft', async () => {
  const f = setup();
  await f.staff.save(f.actor(8, 'admin'), '9', 'moderator', ['create', 'reject']);
  await f.send(9, 'tg:new', true);
  await f.send(9, 'Company');
  await f.staff.save(f.actor(8, 'admin'), '9', 'moderator', []);
  await f.send(9, 'Title');
  const state = await f.states.load(f.actor(9, 'moderator'));
  assert.equal(state.session.step, 'title');
  assert.equal(state.session.draft.title, undefined);
  await f.send(9, '🏠 Admin paneli');
  assert.equal((await f.states.load(f.actor(9, 'moderator'))).session.kind, 'idle');
  await f.send(8, 'staff:add:moderator', true);
  await f.send(8, '🏠 Admin paneli');
  assert.equal((await f.states.load(f.actor(8, 'admin'))).session.kind, 'idle');
});
test('stale permission buttons cannot change another draft or another moderator', async () => {
  const f = setup();
  await f.send(8, 'staff:add:moderator', true);
  await f.send(8, '9');
  const old = await f.states.load(f.actor(8, 'admin'));
  await f.send(8, 'staff:add:moderator', true);
  await f.send(8, '10');
  await f.send(8, `staff:${old.session.nonce}:save`, true);
  assert.equal(await f.staff.get('9'), undefined);
  assert.equal(await f.staff.get('10'), undefined);
});
test('migration protects staff data from public clients and seeds Asim without touching users or jobs', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      'create role anon; create role authenticated; create role service_role bypassrls; create table jobs(id int); insert into jobs values(1);',
    );
    const sql = await readFile(
      new URL(
        '../supabase/migrations/20261007102134_telegram_staff_permissions.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await db.exec(sql);
    assert.equal(
      (await db.query('select role from telegram_staff where user_id=$1', ['5920740941'])).rows[0]
        .role,
      'admin',
    );
    assert.equal((await db.query('select count(*)::int n from jobs')).rows[0].n, 1);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from telegram_staff'), (e) => e.code === '42501');
      await assert.rejects(
        db.query("insert into telegram_staff(user_id,role) values('9','admin')"),
        (e) => e.code === '42501',
      );
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await assert.rejects(
      db.query("insert into telegram_staff(user_id,role) values('9','superadmin')"),
      (e) => e.code === '23514',
    );
    await assert.rejects(
      db.query(
        "insert into telegram_staff(user_id,role,permissions) values('9','moderator',array['unknown'])",
      ),
      (e) => e.code === '23514',
    );
    await db.query(
      "insert into telegram_staff(user_id,role,permissions) values('9','moderator',array['approve','pending'])",
    );
  } finally {
    await db.close();
  }
});

test('staff resolution errors fail closed and wrong-secret webhooks cannot reach access service', async () => {
  let queries = 0,
    operations = 0;
  const controller = new TelegramController(
    new ConfigService({ TELEGRAM_ADMIN_CHAT_ID: '7', TELEGRAM_WEBHOOK_SECRET: 'secret' }),
    {},
    {
      handle: async () => {
        operations++;
        return true;
      },
    },
    {},
    {
      resolve: async () => {
        queries++;
        throw new Error('database unavailable');
      },
    },
  );
  const update = {
    update_id: 1,
    message: { from: { id: 9 }, chat: { id: 9, type: 'private' }, text: '/start' },
  };
  await controller.webhook(update, 'wrong');
  assert.equal(queries, 0);
  await controller.webhook(update, 'secret');
  assert.equal(queries, 1);
  assert.equal(operations, 0);
});

test('one moderator cannot use another moderator permission draft and admin cannot forge admin creation', async () => {
  const f = setup();
  await f.send(8, 'staff:add:moderator', true);
  await f.send(8, '9');
  const state = await f.states.load(f.actor(8, 'admin'));
  await f.send(7, `staff:${state.session.nonce}:save`, true);
  assert.equal(await f.staff.get('9'), undefined);
  await f.send(8, 'staff:add:admin', true);
  assert.equal((await f.states.load(f.actor(8, 'admin'))).session.draft.role, 'moderator');
});
