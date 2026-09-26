import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '../dist/common/errors.js';
import { GenerationWorkerService } from '../dist/video/generation-worker.service.js';

function entities() {
  const now = new Date().toISOString();

  return {
    job: {
      id: 'job-1',
      contactId: 'contact-1',
      status: 'processing',
      provider: 'runway',
      prompt: 'Demo video',
      inputStoragePath: 'inputs/demo.jpg',
      inputMimeType: 'image/jpeg',
      createdAt: now,
      updatedAt: now,
    },

    contact: {
      id: 'contact-1',
      waId: '994501234567',
      state: 'processing',
      freeVideoUsed: false,
      pendingImagePath: 'inputs/demo.jpg',
      pendingImageMime: 'image/jpeg',
      createdAt: now,
      updatedAt: now,
    },
  };
}

test('completed generation sends the video, clears the flow and shows quick actions', async () => {
  const { job, contact } = entities();

  const jobUpdates = [];
  const contactUpdates = [];
  const storedMedia = [];
  const sentVideos = [];
  const quickActions = [];
  const recordedMessages = [];

  let claimed = false;

  const dataStore = {
    getStaleProcessingJobs: async () => [],

    claimNextJob: async () => {
      if (claimed) {
        return undefined;
      }

      claimed = true;
      return job;
    },

    getContactById: async () => contact,

    updateJob: async (_id, patch) => {
      jobUpdates.push(patch);
      return { ...job, ...patch };
    },

    updateContact: async (_id, patch) => {
      contactUpdates.push(patch);
      return { ...contact, ...patch };
    },

    recordMessage: async (message) => {
      recordedMessages.push(message);
      return true;
    },
  };

  const mediaStore = {
    get: async () => Buffer.from('image'),

    put: async (path, bytes, mimeType) => {
      storedMedia.push({
        path,
        bytes,
        mimeType,
      });
    },
  };

  const whatsapp = {
    sendVideo: async (waId, bytes, caption) => {
      sentVideos.push({
        waId,
        bytes,
        caption,
      });

      return 'video-message-id';
    },

    sendQuickActions: async (waId) => {
      quickActions.push(waId);
      return 'quick-actions-message-id';
    },
  };

  const provider = {
    generate: async () => ({
      bytes: Buffer.from('video'),
      mimeType: 'video/mp4',
      providerJobId: 'runway-task-1',
    }),
  };

  const worker = new GenerationWorkerService(
    new ConfigService({}),
    dataStore,
    mediaStore,
    whatsapp,
    provider,
  );

  await worker.tick();

  assert.equal(storedMedia.length, 1);
  assert.equal(
    storedMedia[0].path,
    'outputs/994501234567/job-1.mp4',
  );
  assert.equal(storedMedia[0].mimeType, 'video/mp4');

  assert.equal(sentVideos.length, 1);
  assert.equal(sentVideos[0].waId, '994501234567');
  assert.match(sentVideos[0].caption, /Videonuz hazırdır/);

  assert.equal(jobUpdates.at(-1).status, 'completed');
  assert.equal(
    jobUpdates.at(-1).providerJobId,
    'runway-task-1',
  );

  assert.deepEqual(contactUpdates.at(-1), {
    state: 'new',
    freeVideoUsed: true,
    pendingImagePath: undefined,
    pendingImageMime: undefined,
  });

  assert.deepEqual(quickActions, [
    '994501234567',
  ]);

  assert.deepEqual(
    recordedMessages.map((message) => message.type),
    ['video', 'interactive'],
  );
});

test('generation failure marks the job failed and notifies the WhatsApp user', async () => {
  const { job, contact } = entities();

  const jobUpdates = [];
  const contactUpdates = [];
  const sentTexts = [];
  const quickActions = [];
  const recordedMessages = [];

  let claimed = false;

  const dataStore = {
    getStaleProcessingJobs: async () => [],

    claimNextJob: async () => {
      if (claimed) {
        return undefined;
      }

      claimed = true;
      return job;
    },

    getContactById: async () => contact,

    updateJob: async (_id, patch) => {
      jobUpdates.push(patch);
      return { ...job, ...patch };
    },

    updateContact: async (_id, patch) => {
      contactUpdates.push(patch);
      return { ...contact, ...patch };
    },

    recordMessage: async (message) => {
      recordedMessages.push(message);
      return true;
    },
  };

  const mediaStore = {
    get: async () => Buffer.from('image'),
  };

  const whatsapp = {
    sendText: async (_waId, text) => {
      sentTexts.push(text);
      return 'failure-message-id';
    },

    sendQuickActions: async (waId) => {
      quickActions.push(waId);
      return 'quick-actions-message-id';
    },
  };

  const provider = {
    generate: async () => {
      throw new ExternalServiceError(
        'Runway account does not have enough credits',
        400,
        {
          error: 'You do not have enough credits to run this task.',
        },
        'insufficient_credits',
      );
    },
  };

  const worker = new GenerationWorkerService(
    new ConfigService({}),
    dataStore,
    mediaStore,
    whatsapp,
    provider,
  );

  await worker.tick();

  assert.equal(jobUpdates.at(-1).status, 'failed');
  assert.equal(
    contactUpdates.at(-1).state,
    'awaiting_prompt',
  );

  assert.equal(
    contactUpdates.at(-1).freeVideoUsed,
    undefined,
  );

  assert.match(
    sentTexts[0],
    /Video hazırlana bilmədi/,
  );

  assert.match(
    sentTexts[0],
    /müvəqqəti əlçatan deyil/,
  );

  assert.deepEqual(quickActions, [
    '994501234567',
  ]);

  assert.equal(
    recordedMessages[0].content.event,
    'video-generation-failed',
  );

  assert.equal(
    recordedMessages[1].content.menu,
    'quick-actions',
  );
});
