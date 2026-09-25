import { createHash } from 'node:crypto';
import {
  IncomingMessageEnvelope,
  WhatsAppMessage,
  WhatsAppStatus,
  WhatsAppWebhookPayload,
} from './whatsapp.types';

export function buildWebhookEventKey(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function extractMessages(
  payload: WhatsAppWebhookPayload,
): IncomingMessageEnvelope[] {
  const result: IncomingMessageEnvelope[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const contacts = change.value?.contacts ?? [];
      const names = new Map<string, string | undefined>();

      for (const contact of contacts) {
        if (contact.wa_id) {
          names.set(contact.wa_id, contact.profile?.name);
        }

        if (contact.user_id) {
          names.set(contact.user_id, contact.profile?.name);
        }
      }

      for (const rawMessage of change.value?.messages ?? []) {
        const senderId =
          rawMessage.from ?? rawMessage.from_user_id;

        if (!senderId) continue;

        const message = {
          ...rawMessage,
          from: senderId,
        } as WhatsAppMessage;

        result.push({
          message,
          profileName: names.get(senderId),
        });
      }
    }
  }

  return result;
}

export function extractStatuses(
  payload: WhatsAppWebhookPayload,
): WhatsAppStatus[] {
  return (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap(
      (change) => change.value?.statuses ?? [],
    ),
  );
}

export function normalizeCommand(text: string): string {
  return text.trim().toLocaleLowerCase('az-AZ');
}
