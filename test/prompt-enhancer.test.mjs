import assert from 'node:assert/strict';
import test from 'node:test';
import { PromptEnhancerService } from '../dist/ai/prompt-enhancer.service.js';

test('returns the original prompt when AI enhancement is disabled', async () => {
  const values = new Map([
    ['AI_TEXT_PROVIDER', 'none'],
    ['MAX_PROMPT_LENGTH', 1000],
  ]);
  const config = {
    get(name) {
      return values.get(name);
    },
  };

  const service = new PromptEnhancerService(config);
  const prompt = 'Qəhvə fincanından buxar qalxsın';

  assert.equal(await service.enhance(prompt), prompt);
});
