import { createHash } from 'node:crypto';
import { IncomingMessageEnvelope, WhatsAppStatus, WhatsAppWebhookPayload } from './whatsapp.types';

export function buildWebhookEventKey(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function extractMessages(payload: WhatsAppWebhookPayload): IncomingMessageEnvelope[] {
  const result: IncomingMessageEnvelope[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const contacts = change.value?.contacts ?? [];
      const names = new Map(
        contacts.map((contact) => [contact.wa_id, contact.profile?.name] as const),
      );
      for (const message of change.value?.messages ?? []) {
        result.push({ message, profileName: names.get(message.from) });
      }
    }
  }
  return result;
}

export function extractStatuses(payload: WhatsAppWebhookPayload): WhatsAppStatus[] {
  return (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => change.value?.statuses ?? []),
  );
}

export function normalizeCommand(text: string): string {
  return text.trim().toLocaleLowerCase('az-AZ');
}
