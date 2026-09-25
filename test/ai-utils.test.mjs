import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isVideoIntent,
  parseProviderCommand,
  splitText,
} from '../dist/ai/ai.utils.js';

test('parses explicit AI provider commands', () => {
  assert.deepEqual(
    parseProviderCommand('/chatgpt Salam'),
    {
      provider: 'openai',
      text: 'Salam',
    },
  );

  assert.deepEqual(
    parseProviderCommand('/claude analiz et'),
    {
      provider: 'claude',
      text: 'analiz et',
    },
  );
});

test('routes only explicit video requests', () => {
  assert.equal(
    isVideoIntent('Mənə video yarat'),
    true,
  );

  assert.equal(
    isVideoIntent('Salam, necəsən?'),
    false,
  );
});

test('splits long WhatsApp replies', () => {
  const input =
    'bir iki üç dörd beş altı';

  const output =
    splitText(input, 10);

  assert.ok(
    output.every(
      (part) => part.length <= 10,
    ),
  );

  assert.equal(
    output
      .join(' ')
      .replace(/\s+/g, ' '),
    input,
  );
});