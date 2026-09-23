import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptEnhancerService } from '../ai/prompt-enhancer.service';
import { Contact } from '../common/domain';
import { DataStoreService } from '../supabase/data-store.service';
import { MediaStoreService } from '../media/media-store.service';
import { WhatsAppClientService } from './whatsapp-client.service';
import {
  WhatsAppImageMessage,
  WhatsAppMessage,
  WhatsAppTextMessage,
  WhatsAppWebhookPayload,
} from './whatsapp.types';
import { extractMessages, extractStatuses, normalizeCommand } from './webhook.utils';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class WhatsAppProcessorService {
  private readonly logger = new Logger(WhatsAppProcessorService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly dataStore: DataStoreService,
    private readonly mediaStore: MediaStoreService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly promptEnhancer: PromptEnhancerService,
  ) {}

  async process(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const status of extractStatuses(payload)) {
      await this.dataStore.updateMessageStatus(status.id, status.status);
    }

    for (const envelope of extractMessages(payload)) {
      const { message, profileName } = envelope;
      const contact = await this.dataStore.getOrCreateContact(message.from, profileName);
      const isNew = await this.dataStore.recordMessage({
        waMessageId: message.id,
        contactId: contact.id,
        direction: 'inbound',
        type: message.type,
        content: message,
        status: 'received',
      });
      if (!isNew) continue;

      await this.whatsapp.markAsRead(message.id).catch((error: unknown) => {
        this.logger.warn(`Could not mark message ${message.id} as read: ${String(error)}`);
      });
      await this.routeMessage(contact, message);
    }
  }

  private async routeMessage(contact: Contact, message: WhatsAppMessage): Promise<void> {
    if (message.type === 'image') {
      await this.handleImage(contact, message as WhatsAppImageMessage);
      return;
    }
    if (message.type === 'text') {
      await this.handleText(contact, message as WhatsAppTextMessage);
      return;
    }
    await this.reply(
      contact,
      'Hazırda yalnız mətn və məhsul şəkli qəbul edirəm. Əvvəl məhsul şəklini göndərin.',
    );
  }

  private async handleImage(contact: Contact, message: WhatsAppImageMessage): Promise<void> {
    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(contact, 'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.');
      return;
    }

    const media = await this.whatsapp.downloadMedia(message.image.id);
    if (!ALLOWED_IMAGE_TYPES.has(media.mimeType)) {
      await this.reply(contact, 'Şəkil JPG, PNG və ya WEBP formatında olmalıdır.');
      return;
    }

    const maxImageBytes = this.config.get<number>('MAX_IMAGE_BYTES') ?? 5 * 1024 * 1024;
    if (media.fileSize > maxImageBytes || media.bytes.length > maxImageBytes) {
      const maxMegabytes = Math.floor(maxImageBytes / (1024 * 1024));
      await this.reply(
        contact,
        `Şəklin ölçüsü çox böyükdür. Maksimum ${maxMegabytes} MB şəkil göndərin.`,
      );
      return;
    }

    const extension = this.extensionFor(media.mimeType);
    const path = `inputs/${contact.waId}/${message.id}.${extension}`;
    await this.mediaStore.put(path, media.bytes, media.mimeType);
    await this.dataStore.updateContact(contact.id, {
      state: 'awaiting_prompt',
      pendingImagePath: path,
      pendingImageMime: media.mimeType,
    });

    await this.reply(
      contact,
      [
        'Şəkli aldım ✅',
        '',
        'İndi videoda nə baş verməsini istədiyinizi yazın.',
        'Məsələn: “Qəhvə fincanından buxar qalxsın, kamera məhsula yaxınlaşsın, premium reklam görüntüsü olsun.”',
      ].join('\n'),
    );
  }

  private async handleText(contact: Contact, message: WhatsAppTextMessage): Promise<void> {
    const rawText = message.text.body.trim();
    const command = normalizeCommand(rawText);

    if (['kömək', 'komək', 'help', 'menu', 'menyu', 'start', 'başla', 'basla'].includes(command)) {
      await this.reply(contact, this.helpText(contact.profileName));
      return;
    }

    if (['status', 'vəziyyət', 'veziyyet'].includes(command)) {
      await this.sendStatus(contact);
      return;
    }

    if (['ləğv', 'legv', 'cancel'].includes(command)) {
      if (await this.dataStore.hasActiveJob(contact.id)) {
        await this.reply(contact, 'Video artıq hazırlanır və bu mərhələdə dayandırıla bilmir.');
        return;
      }
      await this.dataStore.updateContact(contact.id, {
        state: 'new',
        pendingImagePath: undefined,
        pendingImageMime: undefined,
      });
      await this.reply(
        contact,
        'Sorğu ləğv edildi. Yenidən başlamaq üçün məhsul şəklini göndərin.',
      );
      return;
    }

    if (contact.state !== 'awaiting_prompt' || !contact.pendingImagePath) {
      await this.reply(contact, this.helpText(contact.profileName));
      return;
    }

    const maxPromptLength = this.config.get<number>('MAX_PROMPT_LENGTH') ?? 1000;
    if (rawText.length < 5) {
      await this.reply(contact, 'Təsviri bir az daha ətraflı yazın — minimum 5 simvol.');
      return;
    }
    if (rawText.length > maxPromptLength) {
      await this.reply(contact, `Təsvir maksimum ${maxPromptLength} simvol ola bilər.`);
      return;
    }
    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(contact, 'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.');
      return;
    }

    const enhancedPrompt = await this.promptEnhancer.enhance(rawText);

    await this.dataStore.createJob({
      contactId: contact.id,
      provider: this.config.get<string>('VIDEO_PROVIDER') ?? 'mock',
      prompt: enhancedPrompt,
      inputStoragePath: contact.pendingImagePath,
      inputMimeType: contact.pendingImageMime ?? 'image/jpeg',
    });
    await this.dataStore.updateContact(contact.id, { state: 'processing' });
    await this.reply(
      contact,
      'Sorğunuz qəbul edildi 🎬\nVideo hazırlanır. Hazır olduqda bu söhbətə göndərəcəyəm.',
    );
  }

  private async sendStatus(contact: Contact): Promise<void> {
    const job = await this.dataStore.getLatestJob(contact.id);
    if (!job) {
      await this.reply(
        contact,
        'Aktiv video sorğunuz yoxdur. Başlamaq üçün məhsul şəklini göndərin.',
      );
      return;
    }
    const labels: Record<string, string> = {
      queued: 'növbədədir ⏳',
      processing: 'hazırlanır 🎬',
      completed: 'hazırdır ✅',
      failed: 'xəta ilə dayandı ❌',
    };
    await this.reply(contact, `Son video sorğunuz: ${labels[job.status] ?? job.status}`);
  }

  private async reply(contact: Contact, text: string): Promise<void> {
    const messageId = await this.whatsapp.sendText(contact.waId, text);
    await this.dataStore.recordMessage({
      waMessageId: messageId,
      contactId: contact.id,
      direction: 'outbound',
      type: 'text',
      content: { text },
      status: 'sent',
    });
  }

  private helpText(name?: string): string {
    const greeting = name ? `Salam, ${name}! 👋` : 'Salam! 👋';
    return [
      greeting,
      'AdYarat məhsul şəklinizi qısa reklam videosuna çevirir.',
      '',
      '1️⃣ Məhsul şəklini göndərin',
      '2️⃣ Videoda nə baş verməsini yazın',
      '3️⃣ Hazır videonu buradan alın',
      '',
      'Əmrlər: STATUS, LƏĞV, KÖMƏK',
    ].join('\n');
  }

  private extensionFor(mimeType: string): string {
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/webp') return 'webp';
    return 'jpg';
  }
}
