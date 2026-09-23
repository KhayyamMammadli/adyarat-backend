import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { WebhookSecurityService } from '../dist/whatsapp/webhook-security.service.js';

test('accepts the correct Meta signature and rejects a modified one', () => {
  const secret = 'test-app-secret';
  const body = Buffer.from('{"hello":"world"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const service = new WebhookSecurityService(
    new ConfigService({ NODE_ENV: 'production', META_APP_SECRET: secret }),
  );
  const changedLastCharacter = signature.endsWith('0') ? '1' : '0';
  const modifiedSignature = `${signature.slice(0, -1)}${changedLastCharacter}`;

  assert.equal(service.isValidSignature(signature, body), true);
  assert.equal(service.isValidSignature(modifiedSignature, body), false);
  assert.equal(service.isValidSignature(undefined, body), false);
});

test('checks webhook verification token exactly', () => {
  const service = new WebhookSecurityService(
    new ConfigService({ META_WEBHOOK_VERIFY_TOKEN: 'verify-me' }),
  );
  assert.equal(service.isValidVerifyToken('verify-me'), true);
  assert.equal(service.isValidVerifyToken('wrong'), false);
});
