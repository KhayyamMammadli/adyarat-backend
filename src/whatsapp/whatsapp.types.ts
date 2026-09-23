export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

export interface WhatsAppImageMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'image';
  image: {
    id: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
}

export interface WhatsAppUnknownMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export type WhatsAppMessage = WhatsAppTextMessage | WhatsAppImageMessage | WhatsAppUnknownMessage;

export interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{
          wa_id: string;
          profile?: { name?: string };
        }>;
        messages?: WhatsAppMessage[];
        statuses?: WhatsAppStatus[];
      };
    }>;
  }>;
}

export interface IncomingMessageEnvelope {
  message: WhatsAppMessage;
  profileName?: string;
}

export interface DownloadedMedia {
  bytes: Buffer;
  mimeType: string;
  fileSize: number;
}
