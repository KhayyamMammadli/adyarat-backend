export interface WhatsAppTextMessage {
  from: string;
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

export interface WhatsAppImageMessage {
  from: string;
  from_user_id?: string;
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

export interface WhatsAppAudioMessage {
  from: string;
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: 'audio';
  audio: {
    id: string;
    mime_type?: string;
    sha256?: string;
    voice?: boolean;
  };
}

export interface WhatsAppDocumentMessage {
  from: string;
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: 'document';
  document: {
    id: string;
    mime_type?: string;
    sha256?: string;
    filename?: string;
    caption?: string;
  };
}

export interface WhatsAppInteractiveMessage {
  from: string;
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: 'interactive';
  interactive: {
    type: 'button_reply' | 'list_reply';
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
  };
}

export interface WhatsAppUnknownMessage {
  from: string;
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppAudioMessage
  | WhatsAppDocumentMessage
  | WhatsAppInteractiveMessage
  | WhatsAppUnknownMessage;

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
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          wa_id?: string;
          user_id?: string;
          profile?: {
            name?: string;
            username?: string;
          };
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
