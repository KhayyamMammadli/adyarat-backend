import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DataStoreService } from '../supabase/data-store.service';
import { WhatsAppWebhookPayload } from './whatsapp.types';
import { buildWebhookEventKey } from './webhook.utils';
import { WebhookSecurityService } from './webhook-security.service';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly security: WebhookSecurityService,
    private readonly dataStore: DataStoreService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() response: Response,
  ): void {
    if (mode !== 'subscribe' || !this.security.isValidVerifyToken(verifyToken)) {
      throw new ForbiddenException('Webhook verification failed');
    }
    response.status(200).send(challenge ?? '');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() payload: WhatsAppWebhookPayload,
  ): Promise<{ status: 'received' }> {
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(payload));
    if (!this.security.isValidSignature(signature, rawBody)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    await this.dataStore.enqueueWebhook(buildWebhookEventKey(rawBody), payload);
    return { status: 'received' };
  }
}
