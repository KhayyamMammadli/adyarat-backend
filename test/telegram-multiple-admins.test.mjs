import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { TelegramController } from '../dist/telegram/telegram.controller.js';

function setup(chat = '7', ids = '8') {
  const actors = [];
  const controller = new TelegramController(
    new ConfigService({
      TELEGRAM_ADMIN_CHAT_ID: chat,
      TELEGRAM_ADMIN_USER_IDS: ids,
      TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    }),
    { handleCommand: async () => assert.fail('unexpected legacy operation') },
    {
      handle: async (actor) => {
        actors.push(actor);
        return true;
      },
    },
    { answerCallback: async () => {} },
  );
  const send = (chatId, userId, type = 'private', callback = false, secret = 'test-secret') => {
    const message = { chat: { id: chatId, type }, from: { id: userId }, text: '/start' };
    return controller.webhook(
      callback
        ? { callback_query: { id: 'test', from: message.from, message, data: 'tg:stats' } }
        : { message },
      secret,
    );
  };
  return { actors, send };
}

test('owner retains private access while an additional admin uses their own chat and callbacks', async () => {
  const f = setup();
  await f.send(7, 7);
  await f.send(8, 8);
  await f.send(8, 8, 'private', true);
  assert.deepEqual(f.actors, [
    { chatId: 7, userId: 7, group: false },
    { chatId: 8, userId: 8, group: false },
    { chatId: 8, userId: 8, group: false },
  ]);
});
test('unlisted private users, spoofed private chat and invalid webhook secret stay blocked', async () => {
  const f = setup();
  await f.send(9, 9);
  await f.send(7, 8);
  await f.send(8, 8, 'private', true, 'wrong');
  assert.equal(f.actors.length, 0);
});
test('group operations require both configured group and explicitly listed actor', async () => {
  const f = setup('-100', '7,8');
  await f.send(-100, 8, 'supergroup', true);
  await f.send(-101, 8, 'supergroup', true);
  await f.send(-100, 9, 'supergroup');
  await f.send(8, 8);
  assert.deepEqual(f.actors, [
    { chatId: -100, userId: 8, group: true },
    { chatId: 8, userId: 8, group: false },
  ]);
});
test('without an allowlist only configured private owner retains access', async () => {
  const f = setup('7', '');
  await f.send(7, 7);
  await f.send(8, 8);
  assert.equal(f.actors.length, 1);
});
