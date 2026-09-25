import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWebhookEventKey,
  extractMessages,
  extractStatuses,
  normalizeCommand,
} from '../dist/whatsapp/webhook.utils.js';

const payload = {
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [
              {
                wa_id: '994501234567',
                profile: { name: 'Ayla' },
              },
            ],
            messages: [
              {
                from: '994501234567',
                id: 'wamid.1',
                timestamp: '1',
                type: 'text',
                text: { body: 'Salam' },
              },
            ],
            statuses: [
              {
                id: 'wamid.out',
                status: 'delivered',
                timestamp: '2',
              },
            ],
          },
        },
      ],
    },
  ],
};

test('extracts messages, profile names and delivery statuses', () => {
  assert.deepEqual(extractMessages(payload), [
    {
      message: payload.entry[0].changes[0].value.messages[0],
      profileName: 'Ayla',
    },
  ]);

  assert.equal(extractStatuses(payload)[0].status, 'delivered');
});

test('extracts username messages that use business-scoped user IDs', () => {
  const bsuidPayload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [
                {
                  user_id: 'AZ.1798521701155548',
                  profile: {
                    name: 'Kənan',
                    username: 'kanancavadzade',
                  },
                },
              ],
              messages: [
                {
                  from_user_id: 'AZ.1798521701155548',
                  id: 'wamid.bsuid-1',
                  timestamp: '1790334165',
                  type: 'text',
                  text: {
                    body: 'IPHONE-TEST-1457',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractMessages(bsuidPayload), [
    {
      message: {
        ...bsuidPayload.entry[0].changes[0].value.messages[0],
        from: 'AZ.1798521701155548',
      },
      profileName: 'Kənan',
    },
  ]);
});

test('creates stable event keys and normalizes Azerbaijani commands', () => {
  const body = Buffer.from(JSON.stringify(payload));

  assert.equal(buildWebhookEventKey(body), buildWebhookEventKey(body));
  assert.equal(buildWebhookEventKey(body).length, 64);
  assert.equal(normalizeCommand('  KÖMƏK  '), 'kömək');
});
