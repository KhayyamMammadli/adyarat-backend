import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '../common/errors';
import { DownloadedMedia } from './whatsapp.types';

interface MetaMediaMetadata {
  url: string;
  mime_type?: string;
  file_size?: number;
}

interface MetaMessageResponse {
  messages?: Array<{ id: string }>;
  error?: unknown;
}

interface MetaMediaUploadResponse {
  id?: string;
  error?: unknown;
}

@Injectable()
export class WhatsAppClientService {
  constructor(
    private readonly config: ConfigService,
  ) {}

  async sendText(
    to: string,
    body: string,
  ): Promise<string> {
    const response =
      await this.graphRequest<MetaMessageResponse>(
        `${this.requirePhoneNumberId()}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
              preview_url: false,
              body,
            },
          }),
        },
      );

    const messageId =
      response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendMainMenu(
    to: string,
    profileName?: string,
  ): Promise<string> {
    const greeting = profileName
      ? `Salam, ${profileName}! 👋`
      : 'Salam! 👋';

    const response =
      await this.graphRequest<MetaMessageResponse>(
        `${this.requirePhoneNumberId()}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
              type: 'list',
              header: {
                type: 'text',
                text: 'AdYarat AI',
              },
              body: {
                text: `${greeting}
Mən AI söhbəti, reklam videosu, səsdən mətnə və sənəd tərcüməsi üçün köməkçiyəm. Aşağıdakı düymədən istədiyiniz xidməti seçin.`,
              },
              footer: {
                text: 'Gemini • ChatGPT • Claude • Runway',
              },
              action: {
                button: 'MENYUNU AÇ',
                sections: [
                  {
                    title: 'AI söhbəti',
                    rows: [
                      {
                        id: 'menu_ai',
                        title: '🤖 Avtomatik AI',
                        description:
                          'Uyğun AI avtomatik seçilsin',
                      },
                      {
                        id: 'menu_gemini',
                        title: 'Gemini',
                        description:
                          'Gemini ilə söhbət et',
                      },
                      {
                        id: 'menu_chatgpt',
                        title: 'ChatGPT',
                        description:
                          'ChatGPT ilə söhbət et',
                      },
                      {
                        id: 'menu_claude',
                        title: 'Claude',
                        description:
                          'Claude ilə söhbət et',
                      },
                    ],
                  },
                  {
                    title: 'Yaradıcı alətlər',
                    rows: [
                      {
                        id: 'menu_video',
                        title: '🎬 Video yarat',
                        description:
                          'Məhsul şəklindən reklam videosu',
                      },
                      {
                        id: 'menu_voice',
                        title: '🎙️ Səsi mətnə çevir',
                        description:
                          'WhatsApp səsini yazıya çevir',
                      },
                      {
                        id: 'menu_translate',
                        title: '📚 Sənədi tərcümə et',
                        description:
                          'PDF, DOCX və TXT tərcüməsi',
                      },
                      {
                        id: 'menu_status',
                        title: '📊 Video statusu',
                        description:
                          'Son video sorğusunu yoxla',
                      },
                      {
                        id: 'menu_cancel',
                        title: '❌ Sorğunu ləğv et',
                        description:
                          'Gözləyən video axınını bağla',
                      },
                    ],
                  },
                ],
              },
            },
          }),
        },
      );

    const messageId =
      response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendQuickActions(
    to: string,
  ): Promise<string> {
    const response =
      await this.graphRequest<MetaMessageResponse>(
        `${this.requirePhoneNumberId()}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: {
                text: 'Başqa nə etmək istəyirsiniz?',
              },
              footer: {
                text: 'AdYarat AI',
              },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: {
                      id: 'quick_menu',
                      title: '🏠 Əsas menyu',
                    },
                  },
                  {
                    type: 'reply',
                    reply: {
                      id: 'quick_ai',
                      title: '💬 AI ilə danış',
                    },
                  },
                  {
                    type: 'reply',
                    reply: {
                      id: 'quick_video',
                      title: '🎬 Video yarat',
                    },
                  },
                ],
              },
            },
          }),
        },
      );

    const messageId =
      response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendVideo(
    to: string,
    bytes: Buffer,
    caption: string,
  ): Promise<string> {
    const mediaId =
      await this.uploadMedia(
        bytes,
        'video/mp4',
        'adyarat-video.mp4',
      );

    const response =
      await this.graphRequest<MetaMessageResponse>(
        `${this.requirePhoneNumberId()}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'video',
            video: {
              id: mediaId,
              caption,
            },
          }),
        },
      );

    const messageId =
      response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendDocument(
    to: string,
    bytes: Buffer,
    contentType: string,
    filename: string,
    caption: string,
  ): Promise<string> {
    const mediaId =
      await this.uploadMedia(
        bytes,
        contentType,
        filename,
      );

    const response =
      await this.graphRequest<MetaMessageResponse>(
        `${this.requirePhoneNumberId()}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'document',
            document: {
              id: mediaId,
              filename,
              caption,
            },
          }),
        },
      );

    const messageId =
      response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async markAsRead(
    messageId: string,
  ): Promise<void> {
    await this.graphRequest(
      `${this.requirePhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      },
    );
  }

  async downloadMedia(
    mediaId: string,
  ): Promise<DownloadedMedia> {
    const metadata =
      await this.graphRequest<MetaMediaMetadata>(
        mediaId,
        {
          method: 'GET',
        },
      );

    const response = await fetch(
      metadata.url,
      {
        headers: {
          Authorization:
            `Bearer ${this.requireAccessToken()}`,
        },
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        `Could not download WhatsApp media (${response.status})`,
        response.status,
        await response.text(),
      );
    }

    const bytes = Buffer.from(
      await response.arrayBuffer(),
    );

    return {
      bytes,
      mimeType:
        metadata.mime_type ??
        response.headers.get(
          'content-type',
        ) ??
        'application/octet-stream',
      fileSize:
        metadata.file_size ??
        bytes.length,
    };
  }

  private async uploadMedia(
    bytes: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();

    form.append(
      'messaging_product',
      'whatsapp',
    );

    form.append('type', contentType);

    form.append(
      'file',
      new Blob(
        [Uint8Array.from(bytes)],
        {
          type: contentType,
        },
      ),
      filename,
    );

    const response =
      await this.graphRequest<MetaMediaUploadResponse>(
        `${this.requirePhoneNumberId()}/media`,
        {
          method: 'POST',
          body: form,
        },
      );

    if (!response.id) {
      throw new ExternalServiceError(
        'Meta did not return a media id',
        502,
        response,
      );
    }

    return response.id;
  }

  private async graphRequest<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const version =
      this.config.get<string>(
        'META_GRAPH_API_VERSION',
      ) ?? 'v25.0';

    const response = await fetch(
      `https://graph.facebook.com/${version}/${path}`,
      {
        ...init,
        headers: {
          Authorization:
            `Bearer ${this.requireAccessToken()}`,
          ...init.headers,
        },
      },
    );

    const text = await response.text();

    let body: unknown;

    try {
      body = text
        ? JSON.parse(text)
        : {};
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new ExternalServiceError(
        `Meta Graph API request failed (${response.status})`,
        response.status,
        body,
      );
    }

    return body as T;
  }

  private requireAccessToken(): string {
    const value =
      this.config.get<string>(
        'META_ACCESS_TOKEN',
      );

    if (!value) {
      throw new Error(
        'META_ACCESS_TOKEN is not configured',
      );
    }

    return value;
  }

  private requirePhoneNumberId(): string {
    const value =
      this.config.get<string>(
        'META_PHONE_NUMBER_ID',
      );

    if (!value) {
      throw new Error(
        'META_PHONE_NUMBER_ID is not configured',
      );
    }

    return value;
  }
}
