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

  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.bytes.length > 1000);
  assert.match(result.providerJobId, /^mock-/);
});
