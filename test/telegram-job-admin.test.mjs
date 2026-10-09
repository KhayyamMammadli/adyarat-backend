import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { TelegramController } from '../dist/telegram/telegram.controller.js';
import { TelegramJobAdminService } from '../dist/telegram/telegram-job-admin.service.js';
import { TelegramAdminStateService } from '../dist/telegram/telegram-admin-state.service.js';
import { TelegramAdminService as TelegramTransport } from '../dist/telegram/telegram.service.js';
import { fixture, employerDraft, seeker, seedJobs, last } from './helpers/job-agent-fixture.mjs';

function adminFixture(config = {}) {
  const f = fixture();
  const messages = [];
  const answered = [];
  const cleared = [];
  const legacy = [];
  const telegram = {
    sendTo: async (chatId, text, markup) => {
      const message_id = messages.length + 100;
      messages.push({ chatId, text, markup, message_id });
      return { message_id };
    },
    answerCallback: async (...args) => answered.push(args),
    clearButtons: async (...args) => cleared.push(args),
  };
  const states = new TelegramAdminStateService({ client: f.client });
  let jobs = new TelegramJobAdminService(f.admin, states, telegram, f.businesses);
  const settings = new ConfigService({
    TELEGRAM_ADMIN_CHAT_ID: '7',
    TELEGRAM_WEBHOOK_SECRET: 'fixture-secret',
    ...config,
  });
  let controller = new TelegramController(
    settings,
    { handleCommand: async (text) => legacy.push(text) },
    jobs,
    telegram,
  );
  let updateId = 0;
  const message = (text, extras = {}) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: { id: 7, type: 'private' },
      from: { id: 7 },
      text,
      ...extras,
    },
  });
  const callback = (data, extras = {}) => ({
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 7 },
      message: { message_id: 99, chat: { id: 7, type: 'private' } },
      data,
      ...extras,
    },
  });
  const send = (update) => controller.webhook(update, 'fixture-secret');
  const session = () =>
    f.tables.employer_profiles.find((p) => p.metadata?.telegram_admin_session)?.metadata
      .telegram_admin_session;
  const restart = () => {
    jobs = new TelegramJobAdminService(f.admin, states, telegram, f.businesses);
    controller = new TelegramController(
      settings,
      { handleCommand: async (text) => legacy.push(text) },
      jobs,
      telegram,
    );
  };
  return {
    ...f,
    messages,
    answered,
    cleared,
    legacy,
    session,
    states,
    settings,
    telegram,
    restart,
    controller: () => controller,
    send,
    message,
    callback,
    tgText: (text) => send(message(text)),
    click: (data) => send(callback(data)),
  };
}
async function fillDraft(f, salary = '1000–2000', contact = '+994501234567 hr@example.com') {
  await f.tgText('/admin');
  await f.click('tg:new');
  for (const text of [
    'Mock Tech',
    'Frontend developer',
    'React və TypeScript təcrübəsi',
    'Bakı, Nizami 10',
  ])
    await f.tgText(text);
  await f.click(`tg:create:${f.session().nonce}:mode:office`);
  await f.send(f.message(undefined, { location: { latitude: 40.4, longitude: 49.8 } }));
  if (salary === null) await f.click(`tg:create:${f.session().nonce}:salary:negotiable`);
  else await f.tgText(salary);
  await f.tgText(contact);
}
async function pendingWhatsapp(f) {
  const job = await employerDraft(f);
  await f.action(`job:confirm:${job.id}`);
  return job;
}

test('WhatsApp employer submission attaches approve/reject inline buttons', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  assert.equal(job.status, 'pending');
  assert.deepEqual(
    f.noticeButtons.at(-1).inline_keyboard[0].map((b) => b.callback_data),
    ['tg:approve:1', 'tg:reject:1'],
  );
  assert.doesNotMatch(f.notices.at(-1), /\/approve|\/reject/);
});
test('approve callback activates shared vacancy and appears immediately in WhatsApp all/matching views', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.click(`tg:approve:${job.id}`);
  assert.equal(job.status, 'active');
  assert.ok(job.published_at);
  assert.equal(f.answered.length, 1);
  assert.deepEqual(f.cleared[0], [7, 99]);
  await f.action('job:all');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.endsWith(`:${job.id}`)));
  await seeker(f);
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.endsWith(`:${job.id}`)));
});
test('reject callback requests reason before changing status; reason persists and notifies correct employer', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.click(`tg:reject:${job.id}`);
  assert.equal(job.status, 'pending');
  assert.equal(f.session().kind, 'reject');
  assert.ok(f.messages.some((m) => m.markup?.force_reply));
  await f.tgText('Əlaqə məlumatını dəqiqləşdirin');
  assert.equal(job.status, 'rejected');
  assert.equal(job.metadata.moderation_reason, 'Əlaqə məlumatını dəqiqləşdirin');
  assert.equal(job.metadata.employer_profile_id, 'p1');
  assert.equal(f.session().kind, 'idle');
  const notice = f.sent.find(
    (m) => m.name === 'sendText' && m.args[1].includes('Əlaqə məlumatını dəqiqləşdirin'),
  );
  assert.equal(notice.args[0], 'wa1');
  await f.action('job:all');
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('reject reason survives restart and is tied to current prompt', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.click(`tg:reject:${job.id}`);
  f.restart();
  await f.send(f.message('Wrong reply', { reply_to_message: { message_id: -1 } }));
  assert.equal(job.status, 'pending');
  await f.tgText('Uyğun deyil');
  assert.equal(job.status, 'rejected');
  assert.equal(job.metadata.moderation_reason, 'Uyğun deyil');
});
test('reject reason is nonempty and bounded, cancellation leaves vacancy pending', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.click(`tg:reject:${job.id}`);
  await f.tgText(' ');
  await f.tgText('R'.repeat(501));
  assert.equal(job.status, 'pending');
  await f.click(`tg:cancel:${f.session().nonce}`);
  assert.equal(f.session().kind, 'idle');
  assert.equal(job.status, 'pending');
  await assert.rejects(f.admin.reject(job.id, ''), /1–500/);
});
test('another admin approval makes later rejection stale without modifying active vacancy', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.click(`tg:reject:${job.id}`);
  await f.admin.approve(job.id);
  await f.tgText('Reason');
  assert.equal(job.status, 'active');
  assert.equal(job.metadata.moderation_reason, undefined);
  assert.match(f.messages.at(-1).text, /artıq moderasiya/);
});
test('/admin opens button panel and create flow previews all model fields before publication', async () => {
  const f = adminFixture();
  await fillDraft(f);
  assert.ok(
    f.messages.find((m) => m.markup?.inline_keyboard).markup.inline_keyboard.some((row) =>
      row.some((b) => b.callback_data === 'tg:new'),
    ),
  );
  assert.equal(f.session().step, 'confirm');
  assert.equal(f.tables.jobs.length, 0);
  const draft = f.session().draft;
  assert.equal(draft.company_name, 'Mock Tech');
  assert.equal(draft.title, 'Frontend developer');
  assert.equal(draft.salary_min, 1000);
  assert.equal(draft.salary_max, 2000);
  assert.equal(draft.contact_phone, '+994501234567');
  assert.equal(draft.contact_email, 'hr@example.com');
  const nonce = f.session().nonce;
  await f.click(`tg:create:${nonce}:publish`);
  const job = f.tables.jobs[0];
  assert.equal(job.status, 'active');
  assert.equal(job.source, 'telegram_admin');
  assert.ok(job.published_at);
  assert.equal(job.metadata.telegram_admin_user_id, 7);
  assert.equal(f.session().kind, 'idle');
  assert.equal(f.notices.length, 0);
});
test('Telegram-created active job uses existing WhatsApp all/matching/detail and pagination', async () => {
  const f = adminFixture();
  await seeker(f);
  seedJobs(f, 7);
  await fillDraft(f);
  await f.click(`tg:create:${f.session().nonce}:publish`);
  const job = f.tables.jobs.at(-1);
  assert.equal(job.company_name, 'Mock Tech');
  await f.action('job:all');
  const rows = last(f, 'sendJobList').args[2];
  assert.ok(rows.some((r) => r.id.endsWith(`:${job.id}`)));
  assert.ok(rows.some((r) => r.id === 'job:page:all:1'));
  await f.action(`job:detail:all:0:${job.id}`);
  assert.match(last(f, 'sendText').args[1], /hr@example.com/);
  assert.match(last(f, 'sendText').args[1], /React və TypeScript/);
  await f.action('job:page:all:1');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id === 'job:page:all:0'));
  await f.action('job:matches');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.endsWith(`:${job.id}`)));
});
test('Telegram vacancies follow same matching exclusions as WhatsApp vacancies', async () => {
  const f = adminFixture();
  await seeker(f);
  await fillDraft(f);
  await f.click(`tg:create:${f.session().nonce}:publish`);
  f.tables.jobs[0].location_name = 'Gəncə';
  await f.action('job:matches');
  assert.ok(!last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
  await f.action('job:all');
  assert.ok(last(f, 'sendJobList').args[2].some((r) => r.id.startsWith('job:detail')));
});
test('fixed salary and email-only contact are supported; negotiable salary remains undisclosed', async () => {
  const f = adminFixture();
  await fillDraft(f, '1500', 'hr@example.com');
  await f.click(`tg:create:${f.session().nonce}:publish`);
  assert.equal(f.tables.jobs[0].salary_min, 1500);
  assert.equal(f.tables.jobs[0].salary_max, 1500);
  assert.equal(f.tables.jobs[0].contact_phone, null);
  await fillDraft(f, null, '+994501234567');
  await f.click(`tg:create:${f.session().nonce}:publish`);
  assert.equal(f.tables.jobs.length, 2);
  assert.equal(f.tables.jobs[1].salary_min, null);
  assert.equal(f.tables.jobs[1].salary_max, null);
});
test('invalid salary range/contact/oversized company cannot advance creation', async () => {
  const f = adminFixture();
  await f.click('tg:new');
  await f.tgText('C'.repeat(161));
  assert.equal(f.session().step, 'company_name');
  for (const text of ['Company', 'Title', 'Description', 'Bakı']) await f.tgText(text);
  await f.click(`tg:create:${f.session().nonce}:mode:hybrid`);
  await f.send(f.message(undefined, { location: { latitude: 40.4, longitude: 49.8 } }));
  for (const text of ['2000-1000', '-100', 'abc', '1000001']) {
    await f.tgText(text);
    assert.equal(f.session().step, 'salary');
  }
  await f.tgText('1000,50–2000,75');
  assert.equal(f.session().step, 'contact');
  await f.tgText('not contact');
  assert.equal(f.session().step, 'contact');
});
test('stale creation controls cannot publish or change another session', async () => {
  const f = adminFixture();
  await fillDraft(f);
  const oldNonce = f.session().nonce;
  await f.tgText('/admin');
  await f.click('tg:new');
  const current = f.session().nonce;
  await f.click(`tg:create:${oldNonce}:publish`);
  await f.click(`tg:create:${oldNonce}:mode:remote`);
  await f.click(`tg:cancel:${oldNonce}`);
  assert.equal(f.session().nonce, current);
  assert.equal(f.session().step, 'company_name');
  assert.equal(f.tables.jobs.length, 0);
});
test('duplicate Telegram update cannot advance state twice or create duplicate jobs', async () => {
  const f = adminFixture();
  await f.click('tg:new');
  const update = f.message('Company');
  await f.send(update);
  await f.send(update);
  assert.equal(f.session().step, 'title');
  await f.tgText('Title');
  await f.tgText('Description');
  await f.tgText('Bakı');
  await f.click(`tg:create:${f.session().nonce}:mode:office`);
  await f.send(f.message(undefined, { location: { latitude: 40.4, longitude: 49.8 } }));
  await f.tgText('1000');
  await f.tgText('+994501234567');
  const publish = f.callback(`tg:create:${f.session().nonce}:publish`);
  await f.send(publish);
  await f.send(publish);
  assert.equal(f.tables.jobs.length, 1);
});
test('idempotent publication recovers after session write failure and service restart', async () => {
  const f = adminFixture();
  await fillDraft(f);
  const action = `tg:create:${f.session().nonce}:publish`;
  f.fail('employer_profiles', new Error('session unavailable'), 'update');
  await assert.rejects(f.click(action), /session unavailable/);
  assert.equal(f.tables.jobs.length, 1);
  assert.equal(f.session().step, 'confirm');
  f.restart();
  await f.click(action);
  assert.equal(f.tables.jobs.length, 1);
  assert.equal(f.session().kind, 'idle');
});
test('creation DB failure preserves confirmation for retry', async () => {
  const f = adminFixture();
  await fillDraft(f);
  f.fail('jobs', new Error('DB unavailable'), 'upsert');
  await assert.rejects(f.click(`tg:create:${f.session().nonce}:publish`), /DB unavailable/);
  assert.equal(f.session().step, 'confirm');
  assert.equal(f.tables.jobs.length, 0);
});
test('expired session cannot publish and offers fresh panel', async () => {
  const f = adminFixture();
  await fillDraft(f);
  f.session().expiresAt = '2020-01-01';
  await f.click(`tg:create:${f.session().nonce}:publish`);
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.session().kind, 'idle');
});
test('unauthorized callbacks/messages and wrong secret cannot read or mutate admin/job state', async () => {
  const f = adminFixture();
  const actions = ['tg:new', 'tg:approve:1', 'tg:reject:1'];
  for (const data of actions) await f.send(f.callback(data, { from: { id: 8 } }));
  await f.send(f.message('/admin', { from: { id: 8 } }));
  await f.send(f.message('/admin', { from: undefined }));
  const wrong = f.callback('tg:new');
  await f.controller().webhook(wrong, 'wrong');
  assert.equal(f.tables.job_agent_profiles.length, 0);
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.answered.length, actions.length);
});
test('private authorization checks callback sender, not the bot sender of its message', async () => {
  const f = adminFixture();
  await f.send(
    f.callback('tg:new', {
      message: { message_id: 3, from: { id: 999, is_bot: true }, chat: { id: 7, type: 'private' } },
    }),
  );
  assert.equal(f.session().step, 'company_name');
});
test('group admin chat needs explicit allowed user IDs and reason replies are user/prompt scoped', async () => {
  const f = adminFixture({ TELEGRAM_ADMIN_CHAT_ID: '-100', TELEGRAM_ADMIN_USER_IDS: '7,8' });
  const job = await pendingWhatsapp(f);
  const group = { id: -100, type: 'supergroup' };
  await f.send(f.callback(`tg:reject:${job.id}`, { message: { message_id: 99, chat: group } }));
  await f.send(f.message('Unbound', { chat: group }));
  assert.equal(job.status, 'pending');
  await f.send(
    f.message('Other user', {
      chat: group,
      from: { id: 8 },
      reply_to_message: { message_id: f.session().promptMessageId },
    }),
  );
  assert.equal(job.status, 'pending');
  await f.send(
    f.message('Reason', {
      chat: group,
      reply_to_message: { message_id: f.session().promptMessageId },
    }),
  );
  assert.equal(job.status, 'rejected');
  const denied = adminFixture({ TELEGRAM_ADMIN_CHAT_ID: '-100' });
  await denied.send(denied.callback('tg:new', { message: { chat: group } }));
  assert.equal(denied.calls.length, 0);
});
test('production webhook fails closed without a configured secret', async () => {
  const f = adminFixture({ NODE_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: '' });
  await f.send(f.callback('tg:new'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.answered.length, 0);
});
test('pending list includes buttons on every bounded vacancy and legacy help routing is preserved', async () => {
  const f = adminFixture();
  seedJobs(f, 10);
  f.tables.jobs.forEach((j) => {
    j.status = 'pending';
    j.description = 'D'.repeat(1500);
  });
  await f.tgText('/pending');
  assert.equal(f.messages.length, 11);
  assert.ok(f.messages.every((m) => m.text.length <= 4096));
  assert.ok(f.messages.slice(1).every((m) => m.markup.inline_keyboard[0].length === 2));
  await f.tgText('/help');
  assert.deepEqual(f.legacy, ['/help']);
});
test('old /approve and /reject commands remain supported with mandatory rejection reason', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  await f.tgText(`/reject ${job.id}`);
  assert.equal(f.session().kind, 'reject');
  await f.tgText('Reason');
  assert.equal(job.status, 'rejected');
  await f.tgText('/approve 999');
  assert.match(f.messages.at(-1).text, /artıq moderasiya/);
});
test('WhatsApp notification failure does not undo a successful moderation', async () => {
  const f = adminFixture();
  const job = await pendingWhatsapp(f);
  f.whatsapp.sendText = async () => {
    throw new Error('Meta unavailable');
  };
  await f.click(`tg:approve:${job.id}`);
  assert.equal(job.status, 'active');
  assert.match(f.messages.at(-1).text, /təsdiqləndi/);
});
test('Telegram transport serializes inline keyboard, callback ack and keyboard cleanup', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').at(-1), payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    const transport = new TelegramTransport(
      new ConfigService({ TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_ADMIN_CHAT_ID: '7' }),
    );
    await transport.sendMessage('Vacancy', {
      inline_keyboard: [[{ text: 'Approve', callback_data: 'tg:approve:1' }]],
    });
    await transport.answerCallback('callback');
    await transport.clearButtons(7, 1);
    assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'tg:approve:1');
    assert.equal(calls[1].method, 'answerCallbackQuery');
    assert.deepEqual(calls[2].payload.reply_markup.inline_keyboard, []);
    await assert.rejects(
      transport.sendTo(7, 'text', {
        inline_keyboard: [[{ text: 'bad', callback_data: 'ı'.repeat(33) }]],
      }),
      /1–64/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

for (const mode of ['office', 'hybrid'])
  test(`Telegram ${mode} waits for GPS, rejects text/invalid pin and persists location`, async () => {
    const f = adminFixture();
    await f.click('tg:new');
    for (const text of ['Company', 'Title', 'Description', 'Bakı']) await f.tgText(text);
    await f.click(`tg:create:${f.session().nonce}:mode:${mode}`);
    assert.equal(f.session().step, 'location_pin');
    await f.tgText('1000');
    assert.equal(f.session().step, 'location_pin');
    await f.send(f.message(undefined, { location: { latitude: 100, longitude: 0 } }));
    assert.equal(f.session().step, 'location_pin');
    f.restart();
    await f.send(
      f.message(undefined, {
        venue: {
          location: { latitude: 40.4, longitude: 49.8 },
          address: 'Bakı, Nizami 10',
          title: 'Office',
        },
      }),
    );
    assert.equal(f.session().step, 'salary');
    await f.tgText('1000');
    await f.tgText('hr@example.com');
    assert.match(f.messages.at(-1).text, /google.com\/maps\/search/);
    await f.click(`tg:create:${f.session().nonce}:publish`);
    assert.equal(f.tables.jobs[0].status, 'active');
    assert.equal(f.tables.jobs[0].latitude, 40.4);
    assert.equal(f.tables.jobs[0].longitude, 49.8);
    assert.equal(f.tables.jobs[0].location_name, 'Bakı, Nizami 10');
    await f.action('job:all');
    await f.action('job:detail:all:0:1');
    assert.equal(last(f, 'sendJobLocation').args[1], 40.4);
  });
test('Telegram remote creation does not require coordinates; service rejects incomplete office creation', async () => {
  const f = adminFixture();
  await f.click('tg:new');
  for (const text of ['Company', 'Title', 'Description', 'Bakı']) await f.tgText(text);
  await f.click(`tg:create:${f.session().nonce}:mode:remote`);
  assert.equal(f.session().step, 'salary');
  await f.tgText('1000');
  await f.tgText('hr@example.com');
  await f.click(`tg:create:${f.session().nonce}:publish`);
  assert.equal(f.tables.jobs[0].latitude, undefined);
  assert.equal(f.tables.jobs[0].status, 'active');
  await assert.rejects(
    f.admin.createActive({ title: 'Invalid', work_mode: 'office' }, 'bad', 7),
    /requires coordinates/,
  );
});
test('unauthorized Telegram location cannot advance admin draft; stale location cannot contaminate WhatsApp state', async () => {
  const f = adminFixture();
  await f.click('tg:new');
  for (const text of ['Company', 'Title', 'Description', 'Bakı']) await f.tgText(text);
  await f.click(`tg:create:${f.session().nonce}:mode:office`);
  const location = { latitude: 40.4, longitude: 49.8 };
  await f.send(f.message(undefined, { from: { id: 88 }, location }));
  assert.equal(f.session().step, 'location_pin');
  await f.action('job:seeker');
  await f.send(f.message(undefined, { location }));
  assert.equal(f.tables.job_agent_profiles.find((p) => p.wa_id === 'wa1').state, 'seeker_category');
  assert.equal(f.session().step, 'salary');
});
test('Telegram group location requires reply to current authorized actor prompt', async () => {
  const f = adminFixture({ TELEGRAM_ADMIN_CHAT_ID: '-7', TELEGRAM_ADMIN_USER_IDS: '7' });
  const sendText = async (text) =>
    f.send(
      f.message(text, {
        chat: { id: -7, type: 'supergroup' },
        reply_to_message: { message_id: f.session()?.promptMessageId },
      }),
    );
  const click = async (data) =>
    f.send(f.callback(data, { message: { chat: { id: -7, type: 'supergroup' } } }));
  await click('tg:new');
  for (const text of ['Company', 'Title', 'Description', 'Bakı']) await sendText(text);
  await click(`tg:create:${f.session().nonce}:mode:office`);
  const extras = {
    chat: { id: -7, type: 'supergroup' },
    location: { latitude: 40.4, longitude: 49.8 },
  };
  await f.send(f.message(undefined, extras));
  assert.equal(f.session().step, 'location_pin');
  await f.send(
    f.message(undefined, {
      ...extras,
      reply_to_message: { message_id: f.session().promptMessageId },
    }),
  );
  assert.equal(f.session().step, 'salary');
});
test('legacy persisted Telegram confirm without GPS returns to location step safely', async () => {
  const f = adminFixture();
  await fillDraft(f);
  const session = f.tables.employer_profiles.find((p) => p.metadata?.telegram_admin_session)
    .metadata.telegram_admin_session;
  delete session.draft.latitude;
  delete session.draft.longitude;
  await f.click(`tg:create:${f.session().nonce}:publish`);
  assert.equal(f.session().step, 'location_pin');
  assert.equal(f.tables.jobs.length, 0);
});

test('statistics panel and period pages use buttons and preserve unfinished admin draft; unauthorized callbacks blocked', async () => {
  const f = adminFixture();
  f.admin.statistics = async () => ({
    totalJobs: 21,
    activeJobs: 1,
    pendingJobs: 20,
    totalUsers: 4,
    employers: 1,
    seekers: 2,
    today: 3,
    thisWeek: 8,
  });
  f.admin.periodJobs = async () =>
    Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      title: 'Title',
      company_name: 'Company',
      status: 'pending',
    }));
  await f.click('tg:new');
  const before = f.session();
  await f.click('tg:stats');
  assert.match(f.messages.at(-1).text, /Bütün elanlar: 21/);
  assert.equal(f.session().step, before.step);
  await f.click('tg:stats:day:0');
  assert(
    f.messages
      .at(-1)
      .markup.inline_keyboard.flat()
      .some((b) => b.callback_data === 'tg:stats:day:1'),
  );
  const count = f.messages.length;
  await f.send(f.callback('tg:stats', { from: { id: 99 } }));
  assert.equal(f.messages.length, count);
});

test('plain greeting opens all admin features and installs a persistent command-free launcher', async () => {
  const f = adminFixture();
  await f.tgText('Salam');
  const keyboard = f.messages.find((m) => m.markup?.keyboard)?.markup;
  assert.equal(keyboard.is_persistent, true);
  assert.equal(keyboard.one_time_keyboard, false);
  assert.equal(keyboard.keyboard[0][0].text, '🏠 Admin paneli');
  const actions = f.messages
    .at(-1)
    .markup.inline_keyboard.flat()
    .map((b) => b.callback_data);
  for (const action of ['tg:new', 'tg:pending', 'tg:businesses', 'tg:businesses:rejected', 'tg:stats'])
    assert(actions.includes(action));
  await f.click('tg:new');
  assert.equal(f.session().kind, 'create');
  await f.tgText('🏠 Admin paneli');
  assert.equal(f.session().kind, 'idle');
  assert.equal(f.tables.jobs.length, 0);
});
test('unauthorized messages cannot install admin keyboard', async () => {
  const f = adminFixture();
  await f.send(f.message('🏠 Admin paneli', { from: { id: 99 } }));
  assert.equal(f.messages.length, 0);
});
