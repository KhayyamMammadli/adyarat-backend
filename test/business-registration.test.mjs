import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { fixture, approvedEmployer, employerDraft, last } from './helpers/job-agent-fixture.mjs';
import {
  BusinessRegistrationService,
  businessButtons,
  normalizePhone,
  photoMime,
} from '../dist/job-agent/business-registration.service.js';
import { TaxpayerRegistryService } from '../dist/job-agent/taxpayer-registry.service.js';
import { JobAgentService } from '../dist/job-agent/job-agent.service.js';
import { JobAgentWebhookService } from '../dist/job-agent/job-agent-webhook.service.js';
import { TelegramController } from '../dist/telegram/telegram.controller.js';
import { TelegramAdminStateService } from '../dist/telegram/telegram-admin-state.service.js';
import { TelegramJobAdminService } from '../dist/telegram/telegram-job-admin.service.js';
import { WhatsAppClientService } from '../dist/whatsapp/whatsapp-client.service.js';
const uuid = '11111111-1111-4111-8111-111111111111';
async function voenStep(f, type = 'doner') {
  await f.action('job:employer');
  await f.action(`job:business:type:${type}`);
  await f.text('Ahu dönər');
}
async function pendingBusiness(f) {
  await voenStep(f);
  await f.text('1500315641');
  await f.service.handleImage('wa1', { id: 'image' });
  for (const t of ['Asim', 'Dönər hazırlanması', 'Bakı, Nizami 1', 'hr@example.com', '0501234567'])
    await f.text(t);
  await f.action('job:business:submit');
  return f.tables.employer_profiles[0];
}

test('unavailable production registry permits registration but never verifies or unlocks vacancy publishing', async () => {
  const registry = new TaxpayerRegistryService();
  assert.deepEqual(await registry.lookup('1500315641'), { status: 'unavailable' });
  const f = fixture();
  f.registry.lookup = (voen) => registry.lookup(voen);
  await voenStep(f);
  await f.text('1500315641');
  assert.equal(f.state(), 'business_photo');
  assert.equal(f.tables.employer_profiles[0].voen_verified_at, null);
  assert.equal(f.tables.employer_profiles[0].voen_verification_method, 'pending_admin');
  await f.action('job:employer:new');
  await f.text('A vacancy');
  assert.equal(f.tables.jobs.length, 0);
});
test('nonexistent, mismatched and malformed registry results cannot advance registration', async () => {
  for (const result of [
    { status: 'not_found' },
    { status: 'found', voen: '9999999999', legalName: 'Other', reference: 'ref' },
    { status: 'found', voen: '1500315641', legalName: '', reference: 'ref' },
    { status: 'found', voen: '1500315641', legalName: 'Name', reference: '' },
  ]) {
    const f = fixture();
    f.registry.lookup = async () => {
      if (result === null) throw Error('timeout');
      return result;
    };
    await voenStep(f);
    await f.text('1500315641');
    assert.equal(f.state(), 'employer_voen');
    assert.equal(f.tables.employer_profiles[0].voen_verified_at, undefined);
  }
});
test('real lookup evidence advances to photo, while invalid VÖEN never calls provider', async () => {
  const f = fixture();
  let calls = 0;
  const lookup = f.registry.lookup;
  f.registry.lookup = async (v) => {
    calls++;
    return lookup(v);
  };
  await voenStep(f);
  await f.text('123');
  assert.equal(calls, 0);
  await f.text('1500315641');
  assert.equal(calls, 1);
  assert.equal(f.state(), 'business_photo');
  assert.ok(f.tables.employer_profiles[0].voen_verified_at);
  assert.equal(f.tables.employer_profiles[0].verified, false);
});
test('business kinds cover cafés/restaurants/döner without calling all businesses companies', async () => {
  const f = fixture();
  await f.action('job:employer');
  const rows = last(f, 'sendJobList').args[2];
  for (const id of ['doner', 'kebab', 'restaurant', 'cafe', 'company'])
    assert.ok(rows.some((r) => r.id === `job:business:type:${id}`));
  await f.action('job:business:type:cafe');
  assert.equal(f.state(), 'employer_company');
  assert.match(last(f, 'sendJobButtons').args[1], /Biznesin \/ müəssisənin/);
});
test('mandatory photo accepts image webhook, uses private storage, rejects other file signatures and oversize', async () => {
  const f = fixture();
  await voenStep(f);
  await f.text('1500315641');
  f.whatsapp.downloadMedia = async () => ({
    bytes: Buffer.from('not-image'),
    mimeType: 'image/jpeg',
  });
  await f.service.handleImage('wa1', { id: 'bad' });
  assert.equal(f.state(), 'business_photo');
  f.whatsapp.downloadMedia = async () => {
    throw new Error('WhatsApp media exceeds size limit');
  };
  await f.service.handleImage('wa1', { id: 'large' });
  assert.equal(f.state(), 'business_photo');
  let upload;
  f.whatsapp.downloadMedia = async (id, max) => {
    assert.equal(max, 5242880);
    return { bytes: Buffer.from([255, 216, 255, 224]) };
  };
  f.client.storage.from = (bucket) => ({
    upload: async (...args) => {
      upload = { bucket, args };
      return { error: null };
    },
  });
  const webhook = new JobAgentWebhookService(f.service, f.whatsapp);
  await webhook.process({
    entry: [
      {
        changes: [
          {
            value: { messages: [{ type: 'image', from: 'wa1', id: 'm', image: { id: 'photo' } }] },
          },
        ],
      },
    ],
  });
  assert.equal(upload.bucket, 'job-business-photos');
  assert.equal(upload.args[2].upsert, false);
  assert.match(f.tables.employer_profiles[0].photo_path, /^p1\//);
  assert.equal(f.state(), 'business_contact_name');
  assert.equal(photoMime(Buffer.from('<script>')), undefined);
});
test('photo persistence failure never advances business state', async () => {
  const f = fixture();
  await voenStep(f);
  await f.text('1500315641');
  f.client.storage.from = () => ({
    upload: async () => ({ error: new Error('Storage unavailable') }),
  });
  await assert.rejects(f.service.handleImage('wa1', { id: 'photo' }), /Storage unavailable/);
  assert.equal(f.state(), 'business_photo');
});
test('profile preview and submit create no job; admin approval alone unlocks Add', async () => {
  const f = fixture();
  const e = await pendingBusiness(f);
  assert.equal(e.registration_status, 'pending');
  assert.equal(e.business_type, 'doner');
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(f.state(), 'employer_pending');
  await f.action('job:employer:new');
  await f.text('Cashier');
  assert.equal(f.tables.jobs.length, 0);
  await f.businesses.moderate(e.profile_id, e.registration_token, true, 7);
  assert.equal(e.registration_status, 'approved');
  assert.equal(e.reviewed_by, '7');
  assert.match(last(f, 'sendJobButtons').args[1], /vakansiya paylaşa bilərsiniz/);
  await f.action('job:employer');
  await f.action('job:employer:new');
  await f.text('Cashier');
  assert.equal(f.tables.jobs.length, 1);
  assert.equal(f.tables.jobs[0].status, 'draft');
  assert.equal(f.tables.jobs[0].metadata.business_registration_version, 1);
});
test('stale business decisions are idempotent and rejection keeps business locked', async () => {
  const f = fixture();
  const e = await pendingBusiness(f),
    token = e.registration_token;
  assert.equal(await f.businesses.moderate(e.profile_id, '000000000000', true, 7), false);
  assert.equal(await f.businesses.moderate(e.profile_id, token, false, 7), true);
  assert.equal(await f.businesses.moderate(e.profile_id, token, true, 7), false);
  await f.action('job:employer');
  assert.equal(f.state(), 'employer_rejected');
  await f.action('job:employer:new');
  assert.equal(f.tables.jobs.length, 0);
  await f.action('job:business:edit');
  assert.equal(f.state(), 'business_type');
  assert.equal(e.registration_token, null);
});
test('employer profile omits the seeker minimum-salary preference', async () => {
  const f = fixture();
  await voenStep(f);
  await f.action('job:profile');
  assert.doesNotMatch(last(f, 'sendText').args[1], /Minimum maaş:/);
});
test('rejected businesses appear in the admin re-review queue and can pass fresh manual VÖEN review', async () => {
  const f = fixture();
  f.registry.lookup = async () => ({ status: 'unavailable' });
  const e = await pendingBusiness(f);
  const staleToken = e.registration_token;
  assert.equal(await f.businesses.moderate(e.profile_id, staleToken, false, 7), true);
  assert.notEqual(e.registration_token, staleToken);
  const cards = [];
  f.businesses.telegram.sendPhoto = async (_url, caption, buttons) => {
    cards.push({ caption, buttons });
    return { message_id: 1 };
  };
  f.businesses.telegram.sendTo = async (_chatId, text) => {
    cards.push({ text });
    return { message_id: 1 };
  };
  f.client.storage.from = () => ({
    createSignedUrl: async () => ({ data: { signedUrl: 'https://private.example/photo' }, error: null }),
  });
  await f.businesses.rejected(7);
  assert.ok(cards.some((card) => card.text?.includes('Rədd edilmiş biznes profilləri')));
  assert.ok(
    cards.some((card) =>
      card.buttons?.inline_keyboard[0][0].callback_data.startsWith('bizr:a:'),
    ),
  );
  assert.equal(
    await f.businesses.verifyManually(e.profile_id, e.registration_token, 'Official legal name', 7, 'rejected'),
    true,
  );
  assert.equal(await f.businesses.moderate(e.profile_id, e.registration_token, true, 7, 'rejected'), true);
  assert.equal(e.registration_status, 'approved');
});
test('profile edits invalidate approval and require fresh VÖEN/photo/review', async () => {
  const f = fixture();
  await approvedEmployer(f);
  await f.action('job:employer:edit');
  const e = f.tables.employer_profiles[0];
  assert.equal(e.verified, false);
  assert.equal(e.registration_status, 'draft');
  assert.equal(e.voen_verified_at, null);
  assert.equal(e.photo_path, null);
  await f.action('job:employer:new');
  assert.equal(f.tables.jobs.length, 0);
});
test('seeker and employer share case-normalized email and phone ownership; own contact is reusable', async () => {
  const f = fixture();
  await pendingBusiness(f);
  await f.service.handleInteractive('wa2', 'job:seeker');
  for (const t of ['Chef', 'Bakı', '1', '500']) await f.service.handleText('wa2', t);
  assert.equal(f.tables.job_agent_profiles[1].state, 'seeker_email');
  await f.service.handleText('wa2', 'HR@EXAMPLE.COM');
  assert.equal(f.tables.job_agent_profiles[1].contact_email, undefined);
  await f.service.handleText('wa2', 'candidate@example.com');
  assert.equal(f.tables.job_agent_profiles[1].state, 'seeker_phone');
  await f.service.handleText('wa2', '+994 50 123 45 67');
  assert.equal(f.tables.job_agent_profiles[1].state, 'seeker_phone');
  await f.service.handleText('wa2', '+994551234567');
  assert.equal(f.tables.job_agent_profiles[1].state, 'ready');
  assert.equal(
    await f.businesses.claimContact(f.tables.job_agent_profiles[0], 'email', 'HR@example.com'),
    true,
  );
  assert.equal(normalizePhone('050 123 45 67'), '+994501234567');
  assert.equal(normalizePhone('00994501234567'), '+994501234567');
});
test('admin decision never overwrites a running seeker/filter session; employer remains approved after restart', async () => {
  const f = fixture();
  const e = await pendingBusiness(f);
  await f.action('job:seeker');
  await f.businesses.moderate(e.profile_id, e.registration_token, true, 7);
  assert.equal(f.state(), 'seeker_category');
  const service = new JobAgentService(
    { client: f.client },
    f.whatsapp,
    { sendMessage: async () => {} },
    f.businesses,
  );
  await service.handleInteractive('wa1', 'job:employer');
  assert.equal(f.state(), 'employer_ready');
});
test('forged legacy job-title/confirm states cannot bypass business moderation', async () => {
  const f = fixture();
  const job = await employerDraft(f);
  const e = f.tables.employer_profiles[0];
  e.registration_status = 'pending';
  e.verified = false;
  await f.action('job:confirm:1');
  assert.equal(job.status, 'draft');
  assert.equal(f.state(), 'employer_pending');
  f.tables.job_agent_profiles[0].state = 'employer_job_title';
  await f.text('Another');
  assert.equal(f.tables.jobs.length, 1);
});
test('business photo notification fallback and pending panel use the saved profile', async () => {
  const f = fixture();
  let details = [];
  f.businesses.telegram.sendPhoto = async () => {
    throw Error('Telegram unavailable');
  };
  await pendingBusiness(f);
  assert.equal(f.tables.employer_profiles[0].registration_status, 'pending');
  f.businesses.telegram.sendTo = async (_, text, buttons) => {
    details.push({ text, buttons });
    return { message_id: 1 };
  };
  await f.businesses.pending(7);
  assert.ok(details.some((d) => d.text.includes('Ahu dönər')));
  assert.ok(
    details.some((d) => d.buttons?.inline_keyboard[0][0].callback_data.startsWith('biz:a:')),
  );
});
test('Telegram business callbacks require authorized admin and use revision token without disturbing vacancy state', async () => {
  const f = fixture();
  await f.text('salam');
  f.tables.job_agent_profiles[0].id = uuid;
  const e = await pendingBusiness(f),
    messages = [];
  const telegram = {
    sendTo: async (...args) => {
      messages.push(args);
      return { message_id: 99 };
    },
    answerCallback: async () => {},
    clearButtons: async () => {},
  };
  const states = new TelegramAdminStateService({ client: f.client });
  const jobs = new TelegramJobAdminService(f.admin, states, telegram, f.businesses);
  const controller = new TelegramController(
    new ConfigService({
      TELEGRAM_ADMIN_CHAT_ID: '7',
      TELEGRAM_WEBHOOK_SECRET: 'test',
      NODE_ENV: 'production',
    }),
    { handleCommand: async () => {} },
    jobs,
    telegram,
  );
  const callback = (user, seq) => ({
    update_id: seq,
    callback_query: {
      id: `cb${seq}`,
      from: { id: user },
      message: { message_id: 1, chat: { id: 7, type: 'private' } },
      data: `biz:a:${uuid}:${e.registration_token}`,
    },
  });
  await controller.webhook(callback(8, 1), 'test');
  assert.equal(e.registration_status, 'pending');
  await controller.webhook(callback(7, 2), 'wrong');
  assert.equal(e.registration_status, 'pending');
  await controller.webhook(callback(7, 3), 'test');
  assert.equal(e.registration_status, 'approved');
  assert.ok(messages.some((m) => m[1].includes('Biznes profili təsdiqləndi')));
  await controller.webhook(callback(7, 4), 'test');
  assert.ok(messages.at(-1)[1].includes('artıq yoxlanılıb'));
  assert.ok(
    businessButtons({ ...e, profile_id: uuid })
      .inline_keyboard.flat()
      .every((b) => Buffer.byteLength(b.callback_data) <= 64),
  );
});
test('new business menus/buttons obey WhatsApp native limits', async () => {
  const f = fixture();
  await pendingBusiness(f);
  const client = new WhatsAppClientService(new ConfigService({ META_PHONE_NUMBER_ID: 'fixture' }));
  client.graphRequest = async () => ({ messages: [{ id: 'sent' }] });
  for (const call of f.sent)
    if (['sendJobButtons', 'sendJobList'].includes(call.name))
      await client[call.name](...call.args);
});

test('manual alternative keeps unresolved VÖEN pending until an explicit authorized admin verification', async () => {
  const f = fixture();
  f.registry.lookup = async () => ({ status: 'unavailable' });
  const e = await pendingBusiness(f);
  assert.equal(e.registration_status, 'pending');
  assert.equal(e.voen_verified_at, null);
  assert.equal(await f.businesses.moderate(e.profile_id, e.registration_token, true, 7), false);
  assert.equal(f.tables.jobs.length, 0);
  assert.equal(
    await f.businesses.verifyManually(e.profile_id, '000000000000', 'Official business', 7),
    false,
  );
  assert.equal(await f.businesses.verifyManually(e.profile_id, e.registration_token, '', 7), false);
  assert.equal(
    await f.businesses.verifyManually(e.profile_id, e.registration_token, 'Official business', 7),
    true,
  );
  assert.equal(e.voen_verification_method, 'admin_manual');
  assert.equal(e.voen_verified_by, '7');
  assert.equal(e.registration_status, 'pending');
  await f.businesses.moderate(e.profile_id, e.registration_token, true, 7);
  assert.equal(e.registration_status, 'approved');
  await f.action('job:employer');
  await f.action('job:employer:new');
  await f.text('Chef');
  assert.equal(f.tables.jobs.length, 1);
});
test('unverified manual business can be rejected without inventing registry evidence', async () => {
  const f = fixture();
  f.registry.lookup = async () => {
    throw Error('DVX timeout');
  };
  const e = await pendingBusiness(f);
  assert.equal(await f.businesses.moderate(e.profile_id, e.registration_token, false, 7), true);
  assert.equal(e.registration_status, 'rejected');
  assert.equal(e.voen_verified_at, null);
  assert.equal(e.legal_name, null);
});
test('Telegram manual verification collects official name and explicit confirmation; /cancel never approves', async () => {
  const f = fixture();
  await f.text('salam');
  f.tables.job_agent_profiles[0].id = uuid;
  f.registry.lookup = async () => ({ status: 'unavailable' });
  const e = await pendingBusiness(f);
  const messages = [];
  const telegram = {
    sendTo: async (...args) => {
      messages.push(args);
      return { message_id: messages.length };
    },
    clearButtons: async () => {},
    answerCallback: async () => {},
  };
  const states = new TelegramAdminStateService({ client: f.client }),
    admin = new TelegramJobAdminService(f.admin, states, telegram, f.businesses);
  const controller = new TelegramController(
    new ConfigService({
      TELEGRAM_ADMIN_CHAT_ID: '7',
      TELEGRAM_WEBHOOK_SECRET: 'test',
      NODE_ENV: 'production',
    }),
    { handleCommand: async () => {} },
    admin,
    telegram,
  );
  let seq = 0;
  const click = (data, user = 7) =>
    controller.webhook(
      {
        update_id: ++seq,
        callback_query: {
          id: String(seq),
          from: { id: user },
          message: { message_id: 1, chat: { id: 7, type: 'private' } },
          data,
        },
      },
      'test',
    );
  const text = (body) =>
    controller.webhook(
      {
        update_id: ++seq,
        message: { message_id: seq, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: body },
      },
      'test',
    );
  const session = () =>
    f.tables.employer_profiles.find((p) => p.metadata?.telegram_admin_session)?.metadata
      .telegram_admin_session;
  const approval = `biz:a:${uuid}:${e.registration_token}`;
  await click(approval, 8);
  assert.equal(e.registration_status, 'pending');
  assert.equal(session(), undefined);
  await click(approval);
  assert.equal(session().kind, 'business_verify');
  assert.ok(messages.some((m) => m[1].includes('rəsmi bazada yoxlayın')));
  await text('Official legal name');
  assert.equal(session().step, 'confirm');
  assert.equal(e.voen_verified_at, null);
  const stale = `tg:business:${session().nonce}:verify`;
  await text('/cancel');
  await click(stale);
  assert.equal(e.registration_status, 'pending');
  await click(approval);
  await text('Official legal name');
  await click(`tg:business:${session().nonce}:verify`);
  assert.equal(e.registration_status, 'approved');
  assert.equal(e.legal_name, 'Official legal name');
  assert.equal(e.voen_verified_by, '7');
  assert.equal(session().kind, 'idle');
});
test('manual VÖEN audit fields are cleared when the business profile is edited', async () => {
  const f = fixture();
  f.registry.lookup = async () => ({ status: 'unavailable' });
  const e = await pendingBusiness(f);
  await f.businesses.verifyManually(e.profile_id, e.registration_token, 'Official', 7);
  await f.businesses.moderate(e.profile_id, e.registration_token, true, 7);
  await f.action('job:employer');
  await f.action('job:employer:edit');
  assert.equal(e.voen_verified_by, null);
  assert.equal(e.voen_verification_method, null);
  assert.equal(e.voen_verified_at, null);
  assert.equal(await f.businesses.isApproved(e.profile_id), false);
});
