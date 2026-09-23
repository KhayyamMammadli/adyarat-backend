import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import RunwayML from '@runwayml/sdk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExternalServiceError } from '../common/errors';

export interface VideoGenerationInput {
  image: Buffer;
  imageMimeType: string;
  prompt: string;
}

export interface VideoGenerationResult {
  bytes: Buffer;
  mimeType: 'video/mp4';
  providerJobId?: string;
}

@Injectable()
export class VideoProviderService {
  constructor(private readonly config: ConfigService) {}

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const provider = this.config.get<string>('VIDEO_PROVIDER') ?? 'mock';
    if (provider === 'runway') return this.generateWithRunway(input);
    return this.generateMock();
  }

  private async generateMock(): Promise<VideoGenerationResult> {
    const configuredPath = this.config.get<string>('MOCK_VIDEO_PATH') ?? 'assets/mock-video.mp4';
    return {
      bytes: await readFile(resolve(process.cwd(), configuredPath)),
      mimeType: 'video/mp4',
      providerJobId: `mock-${Date.now()}`,
    };
  }

  private async generateWithRunway(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const apiKey = this.config.get<string>('RUNWAYML_API_SECRET');
    if (!apiKey) throw new Error('RUNWAYML_API_SECRET is not configured');

    const client = new RunwayML({ apiKey });
    const promptImage = `data:${input.imageMimeType};base64,${input.image.toString('base64')}`;
    const model = this.config.get<string>('RUNWAY_MODEL') ?? 'gen4.5';
    if (model !== 'gen4.5') {
      throw new Error('This backend currently supports RUNWAY_MODEL=gen4.5');
    }
    const ratio = this.config.get<string>('RUNWAY_RATIO') ?? '720:1280';
    const allowedRatios = [
      '1280:720',
      '720:1280',
      '1104:832',
      '960:960',
      '832:1104',
      '1584:672',
    ] as const;
    if (!allowedRatios.includes(ratio as (typeof allowedRatios)[number])) {
      throw new Error(`Unsupported RUNWAY_RATIO: ${ratio}`);
    }
    const task = await client.imageToVideo
      .create({
        model,
        promptImage,
        promptText: input.prompt,
        duration: this.config.get<number>('RUNWAY_DURATION') ?? 5,
        ratio: ratio as (typeof allowedRatios)[number],
      })
      .waitForTaskOutput();

    const outputUrl = task.output?.[0];
    if (!outputUrl) {
      throw new ExternalServiceError('Runway completed without a video URL', 502, task);
    }

    const response = await fetch(outputUrl);
    if (!response.ok) {
      throw new ExternalServiceError(
        `Could not download Runway video (${response.status})`,
        response.status,
        await response.text(),
      );
    }

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: 'video/mp4',
      providerJobId: task.id,
    };
  }
}
