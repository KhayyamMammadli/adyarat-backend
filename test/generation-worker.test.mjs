import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '../dist/common/errors.js';
import { GenerationWorkerService } from '../dist/video/generation-worker.service.js';

test(
  'generation failure marks the job failed and notifies the WhatsApp user',
  async () => {
    const jobUpdates = [];
    const contactUpdates = [];
    const sentTexts = [];
    const recordedMessages = [];

    let claimed = false;

    const job = {
      id: 'job-1',
      contactId: 'contact-1',
      status: 'processing',
      provider: 'runway',
      prompt: 'Demo video',
      inputStoragePath: 'inputs/demo.jpg',
      inputMimeType: 'image/jpeg',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const contact = {
      id: 'contact-1',
      waId: '994501234567',
      state: 'processing',
      pendingImagePath: 'inputs/demo.jpg',
      pendingImageMime: 'image/jpeg',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

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

        return {
          ...job,
          ...patch,
        };
      },

      updateContact: async (_id, patch) => {
        contactUpdates.push(patch);

        return {
          ...contact,
          ...patch,
        };
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

      sendQuickActions: async () =>
        'quick-actions-message-id',
    };

    const provider = {
      generate: async () => {
        throw new ExternalServiceError(
          'Runway account does not have enough credits',
          400,
          {
            error:
              'You do not have enough credits to run this task.',
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

    assert.equal(
      jobUpdates.at(-1).status,
      'failed',
    );

    assert.equal(
      contactUpdates.at(-1).state,
      'awaiting_prompt',
    );

    assert.match(
      sentTexts[0],
      /Video hazırlana bilmədi/,
    );

    assert.match(
      sentTexts[0],
      /müvəqqəti əlçatan deyil/,
    );

    assert.equal(
      recordedMessages[0].content.event,
      'video-generation-failed',
    );
  },
);
