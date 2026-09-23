import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { DataStoreService } from '../dist/supabase/data-store.service.js';
import { SupabaseService } from '../dist/supabase/supabase.service.js';

test('memory repository handles an end-to-end job lifecycle', async () => {
  const supabase = new SupabaseService(new ConfigService({}));
  const store = new DataStoreService(supabase);
  const contact = await store.getOrCreateContact('994501234567', 'Ayla');
  await store.updateContact(contact.id, {
    state: 'awaiting_prompt',
    pendingImagePath: 'inputs/test.jpg',
    pendingImageMime: 'image/jpeg',
  });
  await store.createJob({
    contactId: contact.id,
    provider: 'mock',
    prompt: 'Məhsula yaxınlaşan reklam kamerası',
    inputStoragePath: 'inputs/test.jpg',
    inputMimeType: 'image/jpeg',
  });

  assert.equal(await store.hasActiveJob(contact.id), true);
  const job = await store.claimNextJob();
  assert.equal(job.status, 'processing');
  await store.updateJob(job.id, {
    status: 'completed',
    outputStoragePath: 'outputs/test.mp4',
  });
  assert.equal((await store.getLatestJob(contact.id)).status, 'completed');
});
