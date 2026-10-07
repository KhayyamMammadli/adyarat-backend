import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '../common/errors';
import { validCoordinates } from '../job-agent/vacancy-validation';
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
  constructor(private readonly config: ConfigService) {}

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
            ...this.recipientFields(to),
            type: 'text',
            text: {
              preview_url: false,
              body,
            },
          }),
        },
      );

    const messageId = response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendJobLocation(
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<string> {
    if (!validCoordinates({ latitude, longitude })) throw new Error('Invalid location coordinates');
    const response = await this.graphRequest<MetaMessageResponse>(
      `${this.requirePhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...this.recipientFields(to),
          type: 'location',
          location: {
            latitude,
            longitude,
            ...(name ? { name: name.slice(0, 160) } : {}),
            ...(address ? { address: address.slice(0, 250) } : {}),
          },
        }),
      },
    );
    const id = response.messages?.[0]?.id;
    if (!id) throw new ExternalServiceError('Meta did not return a message id', 502, response);
    return id;
  }

  async sendJobList(
    to: string,
    body: string,
    rows: Array<{ id: string; title: string; description?: string }>,
  ): Promise<string> {
    if (
      !rows.length ||
      rows.length > 10 ||
      body.length > 1024 ||
      rows.some(
        (row) =>
          row.title.length > 24 || (row.description?.length ?? 0) > 72 || row.id.length > 200,
      )
    ) {
      throw new Error('Invalid WhatsApp job list limits');
    }
    return this.sendJobInteractive(to, {
      type: 'list',
      body: { text: body },
      action: { button: 'Seçim et', sections: [{ title: 'Vakansiya xidməti', rows }] },
    });
  }

  async sendJobButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<string> {
    if (
      !buttons.length ||
      buttons.length > 3 ||
      body.length > 1024 ||
      buttons.some((button) => button.title.length > 20 || button.id.length > 256)
    ) {
      throw new Error('Invalid WhatsApp job button limits');
    }
    return this.sendJobInteractive(to, {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map((reply) => ({ type: 'reply', reply })) },
    });
  }

  async sendJobMainMenu(
    to: string,
    displayName?: string,
    role?: 'seeker' | 'employer',
  ): Promise<string> {
    return this.sendJobList(
      to,
      `${displayName ? `Salam, ${displayName.slice(0, 100)}! 👋` : 'Salam! 👋'}\nVakansiya xidmətinə xoş gəlmisiniz. Aşağıdan seçim edin.`,
      [
        ...(role === 'employer'
          ? [{ id: 'job:employer:new', title: '➕ Vakansiya yerləşdir' }, { id: 'job:mine', title: '📋 Elanlarım' }]
          : role === 'seeker'
            ? []
            : [
                { id: 'job:seeker', title: '🔎 İş axtarıram' },
                { id: 'job:employer', title: '🏢 İşçi axtarıram' },
              ]),
        { id: 'job:all', title: '📋 Bütün vakansiyalar' },
        { id: 'job:profile', title: '👤 Profilim' },
        { id: 'job:matches', title: 'Mənə uyğun vakansiyalar' },
        ...(role === 'seeker' ? [{ id: 'job:filters', title: '🔍 Filterlə' }] : []),
      ],
    );
  }

  private async sendJobInteractive(
    to: string,
    interactive: Record<string, unknown>,
  ): Promise<string> {
    const response = await this.graphRequest<MetaMessageResponse>(
      `${this.requirePhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...this.recipientFields(to),
          type: 'interactive',
          interactive,
        }),
      },
    );
    const id = response.messages?.[0]?.id;
    if (!id) throw new ExternalServiceError('Meta did not return a message id', 502, response);
    return id;
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
            ...this.recipientFields(to),
            type: 'interactive',
            interactive: {
              type: 'list',
              header: {
                type: 'text',
                text: 'AdYarat',
              },
              body: {
                text: `${greeting}\nMəhsul və xidmətiniz üçün reklam hazırlayaq. Başlamaq üçün aşağıdakı menyudan seçim edin.`,
              },
              footer: {
                text: 'Reklamını asanlıqla yarat',
              },
              action: {
                button: 'MENYUNU AÇ',
                sections: [
                  {
                    title: 'AdYarat xidmətləri',
                    rows: [
                      {
                        id: 'menu_create_ad',
                        title: '✨ Yeni reklam hazırla',
                        description:
                          'Video, mətn və ya səsli reklam yarat',
                      },
                      {
                        id: 'menu_my_ads',
                        title: '📁 Reklamlarım',
                        description:
                          'Son reklam və video vəziyyətinə bax',
                      },
                      {
                        id: 'menu_packages',
                        title: '💳 Paketlər və sifariş',
                        description:
                          'Pilot qiymətləri və sifariş məlumatı',
                      },
                      {
                        id: 'menu_support',
                        title: '💬 Dəstək',
                        description:
                          'Kömək və istifadə qaydaları',
                      },
                    ],
                  },
                ],
              },
            },
          }),
        },
      );

    const messageId = response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }

  async sendAdTypeMenu(
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
            ...this.recipientFields(to),
            type: 'interactive',
            interactive: {
              type: 'button',
              body: {
                text: 'Hansı reklam növünü hazırlamaq istəyirsiniz?',
              },
              footer: {
                text: 'AdYarat',
              },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: {
                      id: 'ad_video',
                      title: '🎬 Video reklam',
                    },
                  },
                  {
                    type: 'reply',
                    reply: {
                      id: 'ad_copy',
                      title: '✍️ Reklam mətni',
                    },
                  },
                  {
                    type: 'reply',
                    reply: {
                      id: 'ad_voice',
                      title: '🎙 Səsli reklam',
                    },
                  },
                ],
              },
            },
          }),
        },
      );

    const messageId = response.messages?.[0]?.id;

    if (!messageId) {
      throw new ExternalServiceError(
        'Meta did not return a message id',
        502,
        response,
      );
    }

    return messageId;
  }


  async sendVideoDurationMenu(
  to: string,
): Promise<string> {
  const durations = [
    10,
    20,
    30,
    40,
    50,
    60,
    70,
    80,
    90,
  ];

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
          ...this.recipientFields(to),
          type: 'interactive',
          interactive: {
            type: 'list',
            body: {
              text: [
                '🎬 Videonun uzunluğunu seçin.',
                '',
                '10 saniyədən 180 saniyəyə qədər video hazırlaya bilərsiniz.',
              ].join('\n'),
            },
            footer: {
              text: 'AdYarat',
            },
            action: {
              button: 'Müddəti seç',
              sections: [
                {
                  title: 'Video müddəti',
                  rows: [
                    ...durations.map(
                      (duration) => ({
                        id: `video_duration_${duration}`,
                        title: `${duration} saniyə`,
                        description:
                          `${duration / 10} səhnə`,
                      }),
                    ),
                    {
                      id: 'video_duration_more',
                      title: '➡️ 100–180 saniyə',
                      description:
                        'Daha uzun video seç',
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



async sendVideoDurationMenuPage2(
  to: string,
): Promise<string> {
  const durations = [
    100,
    110,
    120,
    130,
    140,
    150,
    160,
    170,
    180,
  ];

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
          ...this.recipientFields(to),
          type: 'interactive',
          interactive: {
            type: 'list',
            body: {
              text: [
                '🎬 Uzun video müddətini seçin.',
                '',
                '100–180 saniyə',
              ].join('\n'),
            },
            footer: {
              text: 'AdYarat',
            },
            action: {
              button: 'Müddəti seç',
              sections: [
                {
                  title: 'Uzun video',
                  rows: durations.map(
                    (duration) => ({
                      id: `video_duration_${duration}`,
                      title: `${duration} saniyə`,
                      description:
                        duration === 180
                          ? '18 səhnə • 3 dəqiqə'
                          : `${duration / 10} səhnə`,
                    }),
                  ),
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

  async sendAudio(
    to: string,
    bytes: Buffer,
    contentType = 'audio/mpeg',
    filename = 'adyarat-audio.mp3',
  ): Promise<string> {
    const mediaId = await this.uploadMedia(
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
            ...this.recipientFields(to),
            type: 'audio',
            audio: {
              id: mediaId,
            },
          }),
        },
      );

    const messageId = response.messages?.[0]?.id;

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
  caption?: string,
): Promise<string> {
  const mediaId = await this.uploadMedia(
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
          ...this.recipientFields(to),
          type: 'video',
          video: {
            id: mediaId,
            ...(caption
              ? {
                  caption,
                }
              : {}),
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
          ...this.recipientFields(to),
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: 'Növbəti nə etmək istəyirsiniz?',
            },
            footer: {
              text: 'AdYarat',
            },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: {
                    id: 'quick_new_ad',
                    title: '✨ Yeni reklam',
                  },
                },
                {
                  type: 'reply',
                  reply: {
                    id: 'quick_menu',
                    title: '📋 Menyu',
                  },
                },
                {
                  type: 'reply',
                  reply: {
                    id: 'quick_support',
                    title: '💬 Dəstək',
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


  async sendDocument(
    to: string,
    bytes: Buffer,
    contentType: string,
    filename: string,
    caption: string,
  ): Promise<string> {
    const mediaId = await this.uploadMedia(
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
            ...this.recipientFields(to),
            type: 'document',
            document: {
              id: mediaId,
              filename,
              caption,
            },
          }),
        },
      );

    const messageId = response.messages?.[0]?.id;

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

  async downloadMedia(mediaId: string, maxBytes?: number): Promise<DownloadedMedia> {
    const metadata = await this.graphRequest<MetaMediaMetadata>(mediaId, { method: 'GET' });
    if (maxBytes && metadata.file_size && metadata.file_size > maxBytes)
      throw new Error('WhatsApp media exceeds size limit');
    const response = await fetch(metadata.url, {
      headers: { Authorization: `Bearer ${this.requireAccessToken()}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ExternalServiceError(
        `Could not download WhatsApp media (${response.status})`,
        response.status,
      );
    let bytes: Buffer;
    if (maxBytes) {
      if (!response.body) throw new Error('WhatsApp media is empty');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) throw new Error('WhatsApp media exceeds size limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      bytes = Buffer.concat(chunks);
    } else bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mimeType:
        metadata.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream',
      fileSize: bytes.length,
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

    form.append(
      'type',
      contentType,
    );

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

  private recipientFields(
    value: string,
  ): { to: string } | { recipient: string } {
    return /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]+$/.test(
      value,
    )
      ? { recipient: value }
      : { to: value };
  }
}

