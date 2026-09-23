import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class WebhookSecurityService {
  constructor(private readonly config: ConfigService) {}

  isValidSignature(signature: string | undefined, rawBody: Buffer): boolean {
    const appSecret = this.config.get<string>('META_APP_SECRET');
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';

    if (!appSecret) return !isProduction;
    if (!signature?.startsWith('sha256=')) return false;

    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return (
      actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  isValidVerifyToken(token: string | undefined): boolean {
    const expected = this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    return Boolean(expected && token && expected === token);
  }
}
