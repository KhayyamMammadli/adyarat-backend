import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { VideoProviderService } from '../dist/video/video-provider.service.js';

test('mock provider returns the bundled MP4', async () => {
  const service = new VideoProviderService(
    new ConfigService({
      VIDEO_PROVIDER: 'mock',
      MOCK_VIDEO_PATH: 'assets/mock-video.mp4',
    }),
  );

  const result = await service.generate({
    image: Buffer.from('fake-image'),
    imageMimeType: 'image/jpeg',
    prompt: 'Demo video',
  });

  assert.equal(
    result.mimeType,
    'video/mp4',
  );

  assert.ok(
    result.bytes.length > 1000,
  );

  assert.match(
    result.providerJobId,
    /^mock-/,
  );
});

test('normalizes an immediate Runway credit error without leaving a pending rejection', async () => {
  const originalFetch = globalThis.fetch;

  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;

    return new Response(
      JSON.stringify({
        error:
          'You do not have enough credits to run this task.',
        docUrl:
          'https://docs.dev.runwayml.com/api',
      }),
      {
        status: 400,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  };

  try {
    const service = new VideoProviderService(
      new ConfigService({
        VIDEO_PROVIDER: 'runway',
        RUNWAYML_API_SECRET:
          'test-runway-key',
        RUNWAY_MODEL: 'gen4.5',
        RUNWAY_DURATION: 5,
        RUNWAY_RATIO: '720:1280',
      }),
    );

    await assert.rejects(
      service.generate({
        image: Buffer.from('fake-image'),
        imageMimeType: 'image/jpeg',
        prompt: 'Atlar qaçsın',
      }),
      (error) => {
        assert.equal(
          error.code,
          'insufficient_credits',
        );

        assert.equal(
          error.message,
          'Runway account does not have enough credits',
        );

        return true;
      },
    );

    assert.equal(
      requestCount,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
