import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { TelegramInvitationService } from '../dist/telegram/telegram-invitation.service.js';
import { TelegramStaffService } from '../dist/telegram/telegram-staff.service.js';
import { TelegramStaffMenuService } from '../dist/telegram/telegram-staff-menu.service.js';
import { TelegramAdminStateService } from '../dist/telegram/telegram-admin-state.service.js';
import { TelegramController } from '../dist/telegram/telegram.controller.js';
import { fixture } from './helpers/job-agent-fixture.mjs';

async function setup() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const name of [
    '20261007102134_telegram_staff_permissions.sql',
    '20261007105221_telegram_moderator_invitations.sql',
  ])
    await db.exec(
      await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'),
    );
  await db.query("insert into telegram_staff(user_id,role) values('8','admin')");
  const f = fixture(),
    messages = [],
    operations = [];
  let rpcCalls = 0;
  const client = {
    from(table) {
      if (!['telegram_staff', 'telegram_staff_invites'].includes(table))
        return f.client.from(table);
      let value,
        columns = '*',
        filters = [],
        params = [],
        range,
        sort;
      const q = {
        select(c = '*') {
          columns = c;
          return q;
        },
        insert(v) {
          value = v;
          return q;
        },
        eq(k, v) {
          params.push(v);
          filters.push(`${k}=$${params.length}`);
          return q;
        },
        in(k, v) {
          params.push(v);
          filters.push(`${k}=any($${params.length})`);
          return q;
        },
        gt(k, v) {
          params.push(v);
          filters.push(`${k}>$${params.length}`);
          return q;
        },
        order(k, o) {
          sort = `${k} ${o?.ascending === false ? 'desc' : 'asc'}`;
          return q;
        },
        range(a, b) {
          range = [a, b];
          return q;
        },
        async run(single = false) {
          let sql;
          if (value) {
            const keys = Object.keys(value);
            params = Object.values(value);
            sql = `insert into ${table} (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning ${columns}`;
          } else
            sql = `select ${columns} from ${table}${filters.length ? ' where ' + filters.join(' and ') : ''}${sort ? ' order by ' + sort : ''}${range ? ` limit ${range[1] - range[0] + 1} offset ${range[0]}` : ''}`;
          const { rows } = await db.query(sql, params);
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        },
        single() {
          return q.run(true);
        },
        maybeSingle() {
          return q.run(true);
        },
        then(resolve, reject) {
          return q.run().then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      rpcCalls++;
      const values =
        name === 'claim_telegram_staff_invite'
          ? [args.p_hash, args.p_user_id, args.p_name, args.p_username]
          : [args.p_id, args.p_actor, args.p_owner, args.p_decision];
      const { rows } = await db.query(`select public.${name}($1,$2,$3,$4) as result`, values);
      return { data: rows[0].result, error: null };
    },
  };
  const config = new ConfigService({
    TELEGRAM_ADMIN_CHAT_ID: '7',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  });
  const staff = new TelegramStaffService({ client }, config);
  const telegram = {
    botUsername: async () => 'Fixture_bot',
    sendTo: async (chatId, text, markup) => {
      messages.push({ chatId: String(chatId), text, markup });
      return { message_id: messages.length };
    },
    answerCallback: async () => {},
  };
  const invitations = new TelegramInvitationService({ client }, staff, telegram);
  const states = new TelegramAdminStateService({ client });
  const menu = new TelegramStaffMenuService(staff, states, telegram, invitations);
  const controller = new TelegramController(
    config,
    {},
    {
      handle: async (actor) => {
        operations.push(actor);
        return true;
      },
    },
    telegram,
    staff,
    menu,
    invitations,
  );
  let updateId = 0;
  const send = (user, text, callback = false, secret = 'secret', chat = user, type = 'private') =>
    controller.webhook(
      callback
        ? {
            update_id: ++updateId,
            callback_query: {
              id: String(updateId),
              from: { id: user },
              message: { chat: { id: chat, type } },
              data: text,
            },
          }
        : {
            update_id: ++updateId,
            message: {
              from: { id: user, first_name: 'Candidate', last_name: 'Test', username: 'candidate' },
              chat: { id: chat, type },
              text,
            },
          },
      secret,
    );
  const actor = { userId: 8, chatId: 8, group: false, role: 'admin' };
  const owner = { userId: 7, chatId: 7, group: false, role: 'superadmin' };
  const start = (url) => '/start ' + new URL(url).searchParams.get('start');
  return {
    db,
    client,
    staff,
    states,
    menu,
    invitations,
    messages,
    operations,
    send,
    actor,
    owner,
    start,
    rpcCalls: () => rpcCalls,
    close: () => db.close(),
  };
}

test('link onboarding selects multiple permissions, stores only token hash and requires explicit manager approval', async () => {
  const f = await setup();
  try {
    await f.send(8, 'staff:invite', true);
    const state = await f.states.load(f.actor),
      prefix = `staff:${state.session.nonce}:`;
    await f.send(8, prefix + 'approve', true);
    await f.send(8, prefix + 'pending', true);
    await f.send(8, prefix + 'link', true);
    const url = f.messages.at(-1).text.match(/https:\/\/t.me\/\S+/)[0];
    assert(new URL(url).searchParams.get('start').length <= 64);
    const stored = (await f.db.query('select * from telegram_staff_invites')).rows[0];
    assert(!JSON.stringify(stored).includes(new URL(url).searchParams.get('start').slice(4)));
    await f.send(9, f.start(url));
    assert.equal(await f.staff.resolve(9), undefined);
    const claimed = (await f.db.query('select * from telegram_staff_invites')).rows[0];
    assert.equal(claimed.candidate_id, '9');
    assert.equal(claimed.candidate_username, 'candidate');
    assert(f.messages.some((m) => m.chatId === '8' && m.text.includes('@candidate')));
    await f.send(9, `invite:approve:${claimed.id}`, true); // candidate has no staff access
    assert.equal(await f.staff.resolve(9), undefined);
    await f.send(8, `invite:approve:${claimed.id}`, true);
    assert.deepEqual((await f.staff.resolve(9)).permissions, ['approve', 'pending']);
    assert.equal((await f.staff.resolve(9)).role, 'moderator');
    const row = (await f.db.query('select * from telegram_staff_invites')).rows[0];
    assert.equal(row.status, 'approved');
    await f.send(8, `invite:approve:${claimed.id}`, true);
    assert.equal(
      (await f.db.query("select count(*)::int n from telegram_staff where user_id='9'")).rows[0].n,
      1,
    );
    await f.send(9, '/start');
    assert.equal(f.operations.at(-1).role, 'moderator');
  } finally {
    await f.close();
  }
});
test('one link can be claimed by only one person and replayed Start does not duplicate review notifications', async () => {
  const f = await setup();
  try {
    const { url } = await f.invitations.create(f.actor, ['pending']);
    await Promise.all([f.send(9, f.start(url)), f.send(10, f.start(url))]);
    const i = (await f.db.query('select * from telegram_staff_invites')).rows[0];
    assert(['9', '10'].includes(i.candidate_id));
    const notices = f.messages.filter((m) => m.chatId === '8').length;
    await f.send(Number(i.candidate_id), f.start(url));
    assert.equal(f.messages.filter((m) => m.chatId === '8').length, notices);
    assert.equal(await f.staff.resolve(9), undefined);
    assert.equal(await f.staff.resolve(10), undefined);
  } finally {
    await f.close();
  }
});
test('expired, revoked, rejected and invalid links cannot grant access; pending list recovers a claimed invitation', async () => {
  const f = await setup();
  try {
    const expired = await f.invitations.create(f.actor, ['pending']);
    await f.db.query(
      "update telegram_staff_invites set expires_at=now()-interval '1 second' where id=$1",
      [expired.invite.id],
    );
    await f.send(9, f.start(expired.url));
    const revoked = await f.invitations.create(f.actor, ['pending']);
    await f.invitations.finish(f.owner, revoked.invite.id, 'revoke');
    await f.send(9, f.start(revoked.url));
    const rejected = await f.invitations.create(f.actor, ['pending']);
    await f.send(9, f.start(rejected.url));
    assert.equal((await f.invitations.list(f.actor)).length, 1);
    await f.invitations.finish(f.actor, rejected.invite.id, 'reject');
    await f.send(9, f.start(rejected.url));
    await f.send(9, '/start mod_' + 'a'.repeat(32));
    assert.equal(await f.staff.resolve(9), undefined);
    assert.equal((await f.invitations.list(f.actor)).length, 0);
  } finally {
    await f.close();
  }
});
test('wrong secret, group chat and spoofed user/chat cannot claim; moderator cannot create or approve invitations', async () => {
  const f = await setup();
  try {
    const created = await f.invitations.create(f.actor, ['pending']);
    await f.send(9, f.start(created.url), false, 'wrong');
    assert.equal(f.rpcCalls(), 0);
    await f.send(9, f.start(created.url), false, 'secret', -100, 'group');
    await f.send(9, f.start(created.url), false, 'secret', 10);
    assert.equal(f.rpcCalls(), 0);
    await f.db.query(
      "insert into telegram_staff(user_id,role,permissions) values('11','moderator',array['pending'])",
    );
    await assert.rejects(
      f.invitations.create({ userId: 11, chatId: 11, group: false, role: 'admin' }, ['pending']),
    );
    await assert.rejects(
      f.invitations.finish(
        { userId: 11, chatId: 11, group: false, role: 'admin' },
        created.invite.id,
        'approve',
      ),
    );
    await f.send(11, 'staff:invite', true);
    assert.equal(
      (await f.db.query('select count(*)::int n from telegram_staff_invites')).rows[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});
test('approval cannot overwrite existing staff or grant access after inviter loses admin rights', async () => {
  const f = await setup();
  try {
    const a = await f.invitations.create(f.actor, ['pending']);
    await f.send(9, f.start(a.url));
    await f.db.query("update telegram_staff set active=false where user_id='8'");
    assert.equal(await f.invitations.finish(f.owner, a.invite.id, 'approve'), undefined);
    assert.equal(await f.staff.resolve(9), undefined);
    await f.db.query("update telegram_staff set active=true where user_id='8'");
    await f.db.query(
      "insert into telegram_staff(user_id,role,permissions) values('9','admin',array['statistics'])",
    );
    assert.equal(await f.invitations.finish(f.owner, a.invite.id, 'approve'), undefined);
    assert.equal((await f.staff.resolve(9)).role, 'admin');
  } finally {
    await f.close();
  }
});
test('public database roles cannot read tokens or call invitation RPCs', async () => {
  const f = await setup();
  try {
    for (const role of ['anon', 'authenticated']) {
      await f.db.exec(`set role ${role}`);
      await assert.rejects(
        f.db.query('select * from telegram_staff_invites'),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        f.db.query("select claim_telegram_staff_invite('hash','9','name','username')"),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        f.db.query(
          "select finish_telegram_staff_invite('11111111-1111-4111-8111-111111111111','9','7','approve')",
        ),
        (e) => e.code === '42501',
      );
      await f.db.exec('reset role');
    }
  } finally {
    await f.close();
  }
});

test('claimed invitation expiry blocks approval; zero permissions cannot create a link', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.invitations.create(f.actor, []));
    assert.equal(
      (await f.db.query('select count(*)::int n from telegram_staff_invites')).rows[0].n,
      0,
    );
    const { invite, url } = await f.invitations.create(f.actor, ['approve']);
    await f.send(9, f.start(url));
    await f.db.query(
      "update telegram_staff_invites set expires_at=now()-interval '1 second' where id=$1",
      [invite.id],
    );
    assert.equal(await f.invitations.finish(f.owner, invite.id, 'approve'), undefined);
    assert.equal(await f.staff.resolve(9), undefined);
  } finally {
    await f.close();
  }
});

test('invitation list supports next/back paging without exposing token hashes', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 7; i++) await f.invitations.create(f.actor, ['pending']);
    assert.equal((await f.invitations.list(f.actor, 0)).length, 6);
    assert.equal((await f.invitations.list(f.actor, 1)).length, 2);
    assert(!(await f.invitations.list(f.actor)).some((i) => 'token_hash' in i));
    await f.send(8, 'invite:list', true);
    assert(
      f.messages
        .at(-1)
        .markup.inline_keyboard.flat()
        .some((b) => b.callback_data === 'invite:list:1'),
    );
    await f.send(8, 'invite:list:1', true);
    assert(
      f.messages
        .at(-1)
        .markup.inline_keyboard.flat()
        .some((b) => b.callback_data === 'invite:list:0'),
    );
  } finally {
    await f.close();
  }
});
