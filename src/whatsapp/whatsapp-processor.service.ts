import {
  Injectable,
  Logger,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { AiOrchestratorService } from '../ai/ai-orchestrator.service';

import {
  AiConversationTurn,
  AiProviderName,
} from '../ai/ai.types';

import {
  isVideoIntent,
  parseProviderCommand,
  providerLabel,
  splitText,
} from '../ai/ai.utils';

import { DocumentTranslationService } from '../ai/document-translation.service';

import {
  Contact,
  ConversationMessage,
  VideoDurationSeconds,
} from '../common/domain';

import { MediaStoreService } from '../media/media-store.service';

import { DataStoreService } from '../supabase/data-store.service';

import { WhatsAppClientService } from './whatsapp-client.service';

import {
  WhatsAppAudioMessage,
  WhatsAppDocumentMessage,
  WhatsAppImageMessage,
  WhatsAppInteractiveMessage,
  WhatsAppMessage,
  WhatsAppTextMessage,
  WhatsAppWebhookPayload,
} from './whatsapp.types';

import {
  extractMessages,
  extractStatuses,
  normalizeCommand,
} from './webhook.utils';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable()
export class WhatsAppProcessorService {
  private readonly logger = new Logger(
    WhatsAppProcessorService.name,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly dataStore: DataStoreService,
    private readonly mediaStore: MediaStoreService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly ai: AiOrchestratorService,
    private readonly documents: DocumentTranslationService,
  ) {}

  async process(
    payload: WhatsAppWebhookPayload,
  ): Promise<void> {
    for (const status of extractStatuses(payload)) {
      await this.dataStore.updateMessageStatus(
        status.id,
        status.status,
      );
    }

    for (const envelope of extractMessages(payload)) {
      const { message, profileName } = envelope;

      const contact =
        await this.dataStore.getOrCreateContact(
          message.from,
          profileName,
        );

      const isNew = await this.dataStore.recordMessage({
        waMessageId: message.id,
        contactId: contact.id,
        direction: 'inbound',
        type: message.type,
        content: message,
        status: 'received',
      });

      if (!isNew) continue;

      await this.whatsapp
        .markAsRead(message.id)
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not mark message ${message.id} as read: ${String(error)}`,
          );
        });

      await this.routeMessage(contact, message);
    }
  }

  private async routeMessage(
    contact: Contact,
    message: WhatsAppMessage,
  ): Promise<void> {
    if (
      contact.state === 'awaiting_support_message' &&
      message.type !== 'text'
    ) {
      await this.reply(
        contact,
        'Dəstək müraciətinizi mətn şəklində, mümkün qədər ətraflı yazın. Şəkil və ya fayl lazım olsa, dəstək əməkdaşı sizdən ayrıca istəyəcək.',
      );
      return;
    }

    if (message.type === 'image') {
      return this.handleImage(
        contact,
        message as WhatsAppImageMessage,
      );
    }

    if (message.type === 'audio') {
      return this.handleAudio(
        contact,
        message as WhatsAppAudioMessage,
      );
    }

    if (message.type === 'document') {
      return this.handleDocument(
        contact,
        message as WhatsAppDocumentMessage,
      );
    }

    if (message.type === 'text') {
      return this.handleText(
        contact,
        message as WhatsAppTextMessage,
      );
    }

    if (message.type === 'interactive') {
      return this.handleInteractive(
        contact,
        message as WhatsAppInteractiveMessage,
      );
    }

    await this.reply(
      contact,
      'Bu mesaj növü hələ dəstəklənmir. Mətn, şəkil, səs, PDF, DOCX və ya TXT göndərin.',
    );
  }

  private async handleImage(
    contact: Contact,
    message: WhatsAppImageMessage,
  ): Promise<void> {
    if (!(await this.ensureVideoAccess(contact))) {
      return;
    }

    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(
        contact,
        'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.',
      );
      return;
    }

    const dailyVideoLimit =
  this.config.get<number>(
    'DAILY_VIDEO_LIMIT',
  ) ?? 5;

const last24Hours =
  new Date(
    Date.now() -
      24 * 60 * 60 * 1000,
  );

const recentJobCount =
  await this.dataStore.countRecentJobs(
    contact.id,
    last24Hours,
  );

if (
  recentJobCount >=
  dailyVideoLimit
) {
  await this.reply(
    contact,
    [
      '⏳ Gündəlik video limitiniz tamamlanıb.',
      '',
      `Son 24 saat ərzində maksimum ${dailyVideoLimit} reklam videosu hazırlamaq olar.`,
      '',
      'Limit avtomatik olaraq əvvəlki videoların vaxtı keçdikcə yenilənəcək.',
    ].join('\n'),
  );

  return;
}

    const media = await this.whatsapp.downloadMedia(
      message.image.id,
    );

    if (!ALLOWED_IMAGE_TYPES.has(media.mimeType)) {
      await this.reply(
        contact,
        'Şəkil JPG, PNG və ya WEBP formatında olmalıdır.',
      );
      return;
    }

    const maxBytes =
      this.config.get<number>('MAX_IMAGE_BYTES') ??
      5 * 1024 * 1024;

    if (
      media.fileSize > maxBytes ||
      media.bytes.length > maxBytes
    ) {
      await this.reply(
        contact,
        `Şəkil maksimum ${Math.floor(
          maxBytes / 1024 / 1024,
        )} MB ola bilər.`,
      );
      return;
    }

    const imageValidation =
  await this.ai.validateAdvertisementImage(
    media.bytes,
    media.mimeType,
  );

if (
  !imageValidation.isSuitableForAdvertisement
) {
  await this.reply(
    contact,
    [
      '🚫 Bu şəkil reklam videosu üçün uyğun hesab edilmədi.',
      '',
      'AdYarat yalnız məhsul, xidmət, biznes, brend, restoran, daşınmaz əmlak, avtomobil, tətbiq və digər reklam məqsədli vizuallarla işləyir.',
      '',
      `Səbəb: ${imageValidation.reason}`,
      '',
      'Zəhmət olmasa reklam etmək istədiyiniz məhsul və ya xidmətə aid şəkil göndərin.',
    ].join('\n'),
  );

  return;
}

    const path =
      `inputs/${contact.waId}/${message.id}.` +
      this.imageExtension(media.mimeType);

    await this.mediaStore.put(
      path,
      media.bytes,
      media.mimeType,
    );

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
        'Məsələn: “Qəhvə fincanından buxar qalxsın, kamera yaxınlaşsın, premium reklam olsun.”',
        '',
        'Video istəmirsinizsə, LƏĞV yazın.',
      ].join('\n'),
    );
  }

  private async handleText(
    contact: Contact,
    message: WhatsAppTextMessage,
  ): Promise<void> {
    const rawText = message.text.body.trim();
    const command = normalizeCommand(rawText);

    if (
      this.isSupportOperator(contact.waId) &&
      /^(?:\/)?cavab\s+/iu.test(rawText)
    ) {
      await this.handleSupportReply(contact, rawText);
      return;
    }

    if (
      [
        'kömək',
        'komək',
        'help',
        'menu',
        'menyu',
        'menyunu aç',
        '🚀 menyunu aç',
        'start',
        'başla',
        'basla',
        '/help',
        '/menu',
        '/start',
      ].includes(command)
    ) {
      await this.sendMainMenu(contact);
      return;
    }

    if (
      [
        'status',
        'vəziyyət',
        'veziyyet',
        '/status',
      ].includes(command)
    ) {
      await this.sendStatus(contact);
      return;
    }

    if (
      [
        'ləğv',
        'legv',
        'cancel',
        '/cancel',
      ].includes(command)
    ) {
      await this.cancelVideoFlow(contact);
      return;
    }

    if (
      [
        'dəstək',
        'destek',
        'support',
        '/support',
      ].includes(command)
    ) {
      await this.startSupportFlow(contact);
      return;
    }

    if (contact.state === 'awaiting_support_message') {
      await this.submitSupportRequest(contact, rawText);
      return;
    }

    if (
      contact.state === 'awaiting_prompt' &&
      contact.pendingImagePath
    ) {
      await this.createVideoJob(contact, rawText);
      return;
    }

    if (contact.state === 'awaiting_ad_copy_brief') {
      await this.createAdCopy(contact, rawText);
      return;
    }

    if (
      contact.state === 'awaiting_voice_ad_brief'
    ) {
      await this.createVoiceAd(contact, rawText);
      return;
    }

    if (command.startsWith('/ai ')) {
  const aiText =
    rawText
      .slice(
        rawText.indexOf(' ') + 1,
      )
      .trim();

  const adValidation =
    await this.ai.validateAdvertisementRequest(
      aiText,
    );

  if (!adValidation.isAdvertisement) {
    await this.reply(
      contact,
      [
        '🚫 AdYarat AI yalnız reklam və biznes mövzularında kömək edir.',
        '',
        'Məsələn:',
        '• məhsul üçün reklam ideyası;',
        '• reklam mətni;',
        '• kampaniya ideyası;',
        '• sosial media reklamı;',
        '• məhsul təqdimatı;',
        '• video reklam ssenarisi.',
        '',
        `Səbəb: ${adValidation.reason}`,
      ].join('\n'),
    );

    return;
  }

  await this.handleAiChat(
    contact,
    message.id,
    aiText,
  );

  return;
}

    if (command === '/ai') {
      await this.reply(
        contact,
        '🤖 Sualınızı komandanın yanında yazın. Məsələn: /ai Bakı üçün reklam ideyası ver',
      );
      return;
    }

    if (command === '/video') {
      if (contact.pendingImagePath) {
        await this.dataStore.updateContact(
          contact.id,
          {
            state: 'awaiting_prompt',
          },
        );
      }

      await this.reply(
        contact,
        contact.pendingImagePath
          ? '🎬 Məhsul şəkliniz hazırdır. İndi videoda nə baş verməsini istədiyinizi yazın.'
          : '🎬 Video hazırlamaq üçün əvvəlcə məhsul şəklini göndərin. Sonra videoda nə baş verməsini yazın.',
      );
      return;
    }

    if (command === '/voice') {
      await this.reply(
        contact,
        '🎙️ Səs mesajını bu söhbətə göndərin. Onu avtomatik olaraq mətnə çevirəcəyəm.',
      );
      return;
    }

    if (command === '/translate') {
      await this.reply(
        contact,
        '📚 PDF, DOCX və ya TXT sənədini göndərin. Tərcümə dilini sənədin açıqlamasında yaza bilərsiniz.',
      );
      return;
    }

    const parsed = parseProviderCommand(rawText);

    if (parsed.provider && !parsed.text) {
      const label = providerLabel(parsed.provider);

      await this.reply(
        contact,
        `🤖 ${label} ilə danışmaq üçün komandanın yanında sualınızı yazın.\nMəsələn: /${
          parsed.provider === 'openai'
            ? 'chatgpt'
            : parsed.provider
        } Bakı haqqında qısa məlumat ver`,
      );
      return;
    }

    if (parsed.provider) {
  const adValidation =
    await this.ai.validateAdvertisementRequest(
      parsed.text,
    );

  if (!adValidation.isAdvertisement) {
    const label =
      providerLabel(
        parsed.provider,
      );

    await this.reply(
      contact,
      [
        `🚫 ${label} yalnız reklam və biznes mövzularında istifadə edilə bilər.`,
        '',
        'AdYarat ümumi AI çat xidməti deyil.',
        '',
        'Məsələn belə yaza bilərsiniz:',
        `/${parsed.provider === 'openai' ? 'chatgpt' : parsed.provider} restoran üçün reklam kampaniyası ideyası ver`,
        '',
        `Səbəb: ${adValidation.reason}`,
      ].join('\n'),
    );

    return;
  }

  await this.handleAiChat(
    contact,
    message.id,
    parsed.text,
    parsed.provider,
  );

  return;
}

    if (isVideoIntent(parsed.text)) {
      await this.reply(
        contact,
        '🎬 Video hazırlamaq üçün əvvəlcə məhsul şəklini göndərin. Sonra təsviri yazacaqsınız.',
      );
      return;
    }

    await this.sendMainMenu(contact);
  }

  private async handleInteractive(
    contact: Contact,
    message: WhatsAppInteractiveMessage,
  ): Promise<void> {
    const choiceId =
      message.interactive.list_reply?.id ??
      message.interactive.button_reply?.id ??
      '';

    if (
      choiceId === 'menu_create_ad' ||
      choiceId === 'quick_new_ad'
    ) {
      await this.sendAdTypeMenu(contact);
      return;
    }

    if (choiceId === 'quick_menu') {
      await this.sendMainMenu(contact);
      return;
    }

    if (choiceId === 'menu_my_ads') {
      await this.sendStatus(contact);
      return;
    }

    if (choiceId === 'menu_packages') {
      await this.reply(
        contact,
        [
          '🎁 Pilot mərhələsi',
          '',
          'İlk nümunə reklam pulsuzdur.',
          '10 saniyəlik növbəti reklam üçün sifariş məlumatını dəstək vasitəsilə əldə edə bilərsiniz.',
          '',
          'Onlayn ödəniş sistemi hələ aktiv deyil.',
        ].join('\n'),
      );

      await this.sendQuickActions(contact);
      return;
    }

    if (
      choiceId === 'menu_support' ||
      choiceId === 'quick_support'
    ) {
      await this.startSupportFlow(contact);
      return;
    }

    if (
      choiceId === 'ad_video' ||
      choiceId === 'menu_video' ||
      choiceId === 'quick_video'
    ) {
      if (!(await this.ensureVideoAccess(contact))) {
        return;
      }

      const messageId =
        await this.whatsapp.sendVideoDurationMenu(
          contact.waId,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'interactive',
        content: {
          menu: 'video-duration',
        },
        status: 'sent',
      });

      return;
    }

   if (choiceId === 'video_duration_more') {
  const messageId =
    await this.whatsapp.sendVideoDurationMenuPage2(
      contact.waId,
    );

  await this.dataStore.recordMessage({
    waMessageId: messageId,
    contactId: contact.id,
    direction: 'outbound',
    type: 'interactive',
    content: {
      menu: 'video-duration-page-2',
    },
    status: 'sent',
  });

  return;
}

if (choiceId.startsWith('video_duration_')) {
  const durationValue = Number(
    choiceId.replace(
      'video_duration_',
      '',
    ),
  );

  const allowedDurations: VideoDurationSeconds[] = [
    10,
    20,
    30,
    40,
    50,
    60,
    70,
    80,
    90,
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

  if (
    !allowedDurations.includes(
      durationValue as VideoDurationSeconds,
    )
  ) {
    await this.reply(
      contact,
      'Yanlış video müddəti seçildi. Zəhmət olmasa yenidən seçim edin.',
    );

    return;
  }

  const duration =
    durationValue as VideoDurationSeconds;

  const sceneCount =
    duration / 10;

  const updatedContact =
    await this.dataStore.updateContact(
      contact.id,
      {
        selectedVideoDurationSeconds:
          duration,

        state:
          contact.pendingImagePath
            ? 'awaiting_prompt'
            : 'new',
      },
    );

  await this.reply(
    updatedContact,

    updatedContact.pendingImagePath
      ? [
          `🎬 ${duration} saniyəlik video seçildi.`,
          '',
          `Video ${sceneCount} ayrı 10 saniyəlik səhnə kimi hazırlanacaq və avtomatik birləşdiriləcək.`,
          '',
          'Məhsul şəkliniz artıq hazırdır.',
          'İndi videoda nə baş verməsini istədiyinizi yazın.',
        ].join('\n')

      : [
          `🎬 ${duration} saniyəlik video seçildi.`,
          '',
          `Video ${sceneCount} ayrı 10 saniyəlik səhnə kimi hazırlanacaq və avtomatik birləşdiriləcək.`,
          '',
          'İndi məhsul şəklini göndərin.',
          'Sonra videoda nə baş verməsini istədiyinizi yazacaqsınız.',
        ].join('\n'),
  );

  return;
}

    if (choiceId === 'ad_copy') {
      await this.dataStore.updateContact(
        contact.id,
        {
          state: 'awaiting_ad_copy_brief',
        },
      );

      await this.reply(
        contact,
        [
          '✍️ Reklam mətni hazırlayaq.',
          '',
          'Məhsul və ya xidmətinizi qısa təsvir edin:',
          '• nə təklif edirsiniz;',
          '• əsas üstünlüyü nədir;',
          '• kimlər üçündür;',
          '• varsa qiymət, kampaniya və paylaşılacaq platforma.',
        ].join('\n'),
      );
      return;
    }

    if (choiceId === 'ad_voice') {
      await this.dataStore.updateContact(
        contact.id,
        {
          state: 'awaiting_voice_ad_brief',
        },
      );

      await this.reply(
        contact,
        [
          '🎙 Səsli reklam hazırlayaq.',
          '',
          'Məhsul və ya xidmət haqqında məlumatı mətn və ya səs mesajı kimi göndərin.',
          'AdYarat reklam mətnini və səsləndirilmiş audio faylını hazırlayacaq.',
        ].join('\n'),
      );
      return;
    }
    if (choiceId === 'menu_ai') {
  await this.reply(
    contact,
    [
      '🤖 AdYarat AI yalnız reklam və biznes mövzularında işləyir.',
      '',
      'Məsələn belə yazın:',
      '/ai restoran üçün reklam kampaniyası ideyası ver',
    ].join('\n'),
  );
  return;
}

if (choiceId === 'quick_ai') {
  await this.reply(
    contact,
    [
      '💬 Reklam və biznes mövzusunda sualınızı belə yazın:',
      '',
      '/ai məhsulum üçün Instagram reklam ideyası ver',
    ].join('\n'),
  );
  return;
}

if (choiceId === 'menu_gemini') {
  await this.reply(
    contact,
    [
      '🤖 Gemini yalnız reklam və biznes mövzularında istifadə edilə bilər.',
      '',
      'Məsələn:',
      '/gemini kafe üçün reklam kampaniyası ideyası ver',
    ].join('\n'),
  );
  return;
}

if (choiceId === 'menu_chatgpt') {
  await this.reply(
    contact,
    [
      '🤖 ChatGPT yalnız reklam və biznes mövzularında istifadə edilə bilər.',
      '',
      'Məsələn:',
      '/chatgpt məhsulum üçün reklam mətni hazırla',
    ].join('\n'),
  );
  return;
}

if (choiceId === 'menu_claude') {
  await this.reply(
    contact,
    [
      '🤖 Claude yalnız reklam və biznes mövzularında istifadə edilə bilər.',
      '',
      'Məsələn:',
      '/claude yeni xidmət üçün reklam ssenarisi hazırla',
    ].join('\n'),
  );
  return;
}

    if (choiceId === 'menu_voice') {
      await this.reply(
        contact,
        '🎙️ Səs mesajını göndərin. Onu mətnə çevirəcəyəm.',
      );
      return;
    }

    if (choiceId === 'menu_translate') {
      await this.reply(
        contact,
        '📚 PDF, DOCX və ya TXT sənədini göndərin. İstədiyiniz dili sənədin açıqlamasında yazın.',
      );
      return;
    }

    if (choiceId === 'menu_status') {
      await this.sendStatus(contact);
      return;
    }

    if (choiceId === 'menu_cancel') {
      await this.cancelVideoFlow(contact);
      return;
    }

    await this.sendMainMenu(contact);
  }

  private async handleAiChat(
    contact: Contact,
    currentMessageId: string,
    text: string,
    forcedProvider?: AiProviderName,
  ): Promise<void> {
    try {
      const configured =
        this.config.get<string>(
          'AI_DEFAULT_PROVIDER',
        ) ?? 'auto';

      const provider =
        forcedProvider ??
        (configured === 'auto'
          ? undefined
          : (configured as AiProviderName));

      const history =
        await this.conversationHistory(
          contact.id,
          currentMessageId,
        );

      const result = await this.ai.answer({
        text,
        provider,
        history,
      });

      await this.reply(
        contact,
        `🤖 AdYarat:\n${result.text}`,
        {
          provider: result.provider,
        },
      );

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.warn(
        `AI chat failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        'AI hazırda cavab verə bilmədi. Bir az sonra yenidən yoxlayın və ya KÖMƏK yazın.',
      );

      await this.sendQuickActions(contact);
    }
  }

  private async handleAudio(
    contact: Contact,
    message: WhatsAppAudioMessage,
  ): Promise<void> {
    try {
      const isVoiceAdBrief =
        contact.state ===
        'awaiting_voice_ad_brief';

      await this.reply(
        contact,
        isVoiceAdBrief
          ? '🎙 Səsli məlumat alındı. Reklam ssenarisi hazırlanır...'
          : '🎙️ Səs alındı. Mətnə çevirirəm...',
      );

      const media =
        await this.whatsapp.downloadMedia(
          message.audio.id,
        );

      const maxBytes =
        this.config.get<number>(
          'MAX_AUDIO_BYTES',
        ) ??
        25 * 1024 * 1024;

      if (
        media.fileSize > maxBytes ||
        media.bytes.length > maxBytes
      ) {
        throw new Error(
          `Səs maksimum ${Math.floor(
            maxBytes / 1024 / 1024,
          )} MB ola bilər.`,
        );
      }

      const result = await this.ai.transcribe(
        media.bytes,
        media.mimeType,
        `whatsapp-audio.${this.audioExtension(
          media.mimeType,
        )}`,
      );

      if (isVoiceAdBrief) {
        await this.createVoiceAd(
          contact,
          result.text,
        );
        return;
      }

      const translation =
        await this.ai.translateVoiceCommand(
          result.text,
        );

      if (!translation.shouldTranslate) {
        await this.reply(
          contact,
          `📝 Səsin mətni:\n\n${translation.sourceText}\n\nTərcümə üçün səsin sonunda, məsələn, “bu səsi ingilis dilinə çevir” deyin.`,
          {
            provider: result.provider,
            task: 'transcription',
          },
        );

        await this.sendQuickActions(contact);
        return;
      }

      const targetLanguage =
        translation.targetLanguage!;

      const translatedText =
        translation.translatedText!;

      await this.reply(
        contact,
        `🌍 ${targetLanguage} tərcüməsi:\n\n${translatedText}\n\n🔊 Aşağıdakı səs AI tərəfindən yaradılıb.`,
        {
          provider: translation.provider,
          task: 'voice-translation',
          sourceText: translation.sourceText,
          targetLanguage,
        },
      );

      try {
        const speech =
          await this.ai.synthesizeSpeech(
            translatedText,
            targetLanguage,
          );

        const messageId =
          await this.whatsapp.sendAudio(
            contact.waId,
            speech.bytes,
            speech.mimeType,
            speech.filename,
          );

        await this.dataStore.recordMessage({
          waMessageId: messageId,
          contactId: contact.id,
          direction: 'outbound',
          type: 'audio',
          content: {
            provider: speech.provider,
            task: 'voice-translation',
            targetLanguage,
            text: translatedText,
          },
          status: 'sent',
        });
      } catch (error) {
        this.logger.warn(
          `Translated speech generation failed: ${this.errorMessage(error)}`,
        );

        await this.reply(
          contact,
          'Tərcümə mətni hazırdır, amma səs faylı yaradıla bilmədi. Bir az sonra yenidən yoxlayın.',
        );
      }

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.warn(
        `Audio transcription failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        `Səs mətnə çevrilmədi: ${this.publicError(error)}`,
      );

      await this.sendQuickActions(contact);
    }
  }

  private async handleDocument(
    contact: Contact,
    message: WhatsAppDocumentMessage,
  ): Promise<void> {
    try {
      const filename =
        message.document.filename ?? 'document';

      await this.reply(
        contact,
        '📚 Sənəd alındı. Tərcümə hazırlanır...',
      );

      const media =
        await this.whatsapp.downloadMedia(
          message.document.id,
        );

      const translated =
        await this.documents.translate(
          media.bytes,
          media.mimeType,
          filename,
          message.document.caption,
        );

      const messageId =
        await this.whatsapp.sendDocument(
          contact.waId,
          translated.bytes,
          translated.mimeType,
          translated.filename,
          'Tərcümə hazırdır ✅\nAdYarat tərəfindən hazırlanıb.',
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'document',
        content: {
          filename: translated.filename,
          providers: translated.providers,
          sourceCharacters:
            translated.sourceCharacters,
        },
        status: 'sent',
      });

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.warn(
        `Document translation failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        `Sənəd tərcümə edilmədi: ${this.publicError(error)}`,
      );

      await this.sendQuickActions(contact);
    }
  }

 private async createAdCopy(
  contact: Contact,
  brief: string,
): Promise<void> {
  const cleanBrief =
    brief.trim();

  if (cleanBrief.length < 10) {
    await this.reply(
      contact,
      'Məlumatı bir az daha ətraflı yazın. Məhsulun adı, üstünlüyü və kimlər üçün olduğunu qeyd edin.',
    );
    return;
  }

  const adValidation =
    await this.ai.validateAdvertisementRequest(
      cleanBrief,
    );

  if (!adValidation.isAdvertisement) {
    await this.reply(
      contact,
      [
        '🚫 Göndərdiyiniz məlumat reklam məqsədli kimi qəbul edilmədi.',
        '',
        'Reklam mətni hazırlamaq üçün məhsul, xidmət, biznes, brend və ya kampaniya haqqında məlumat yazın.',
        '',
        'Məsələn:',
        '“Bakıda fəaliyyət göstərən kofe dükanı üçün premium Instagram reklam mətni hazırla.”',
        '',
        `Səbəb: ${adValidation.reason}`,
      ].join('\n'),
    );

    return;
  }

  try {
    await this.reply(
      contact,
      '✍️ Məlumat alındı. Reklam mətniniz hazırlanır...',
    );

    const result =
      await this.ai.answer({
        text: cleanBrief,

        maxOutputTokens: 900,

        systemInstruction: [
          'Sən Azərbaycan bazarı üçün peşəkar reklam kopirayterisən.',
          'AdYarat yalnız reklam və kommersiya məqsədli məzmun hazırlayır.',
          'İstifadəçinin məhsul, xidmət, biznes, brend və ya kampaniya məlumatına əsasən hazır reklam paketi yaz.',
          'Cavab yalnız Azərbaycan dilində olsun.',
          '',
          'Bu quruluşu saxla:',
          '🎯 Başlıq:',
          '📝 Reklam mətni:',
          '📣 Çağırış:',
          '📱 Sosial media paylaşımı:',
          '#️⃣ Hashtag-lər:',
          '',
          'Qaydalar:',
          '- yalnız istifadəçinin verdiyi məlumatlardan istifadə et;',
          '- fakt uydurma;',
          '- verilməyən qiymət əlavə etmə;',
          '- verilməyən endirim və kampaniya uydurma;',
          '- məhsul və ya xidmət haqqında əsassız iddia yazma;',
          '- reklam məqsədindən kənar məzmun yaratma;',
          '- mətni satış və təqdimat yönümlü saxla.',
        ].join('\n'),
      });

    await this.dataStore.updateContact(
      contact.id,
      {
        state: 'new',
      },
    );

    await this.reply(
      contact,
      [
        '✍️ Reklam mətniniz hazırdır:',
        '',
        result.text,
      ].join('\n'),
      {
        provider:
          result.provider,

        task:
          'ad-copy',

        brief:
          cleanBrief,

        validation: {
          productOrService:
            adValidation.productOrService,

          goal:
            adValidation.goal,
        },
      },
    );

    await this.sendQuickActions(
      contact,
    );
  } catch (error) {
    this.logger.warn(
      `Ad copy generation failed: ${this.errorMessage(
        error,
      )}`,
    );

    await this.reply(
      contact,
      'Reklam mətni hazırda yaradıla bilmədi. Məlumatı bir az sonra yenidən göndərin.',
    );

    await this.sendQuickActions(
      contact,
    );
  }
}

  private async createVoiceAd(
  contact: Contact,
  brief: string,
): Promise<void> {
  const voiceText = brief.trim();

  if (voiceText.length < 10) {
    await this.reply(
      contact,
      'Mətni bir az daha ətraflı göndərin.',
    );
    return;
  }

  const adValidation =
    await this.ai.validateAdvertisementRequest(
      voiceText,
    );

  if (!adValidation.isAdvertisement) {
    await this.reply(
      contact,
      [
        '🚫 Göndərdiyiniz mətn reklam məqsədli kimi qəbul edilmədi.',
        '',
        'Səsli reklam yalnız məhsul, xidmət, biznes, brend və kampaniya üçün hazırlana bilər.',
        '',
        'Məsələn:',
        '“Yeni açılan kofe dükanımızı tanıdan qısa reklam mətni.”',
        '',
        `Səbəb: ${adValidation.reason}`,
      ].join('\n'),
    );

    return;
  }

  try {
    await this.reply(
      contact,
      '🎙 Məlumat alındı. Səsli reklamınız hazırlanır...',
    );

    await this.dataStore.updateContact(
      contact.id,
      {
        state: 'new',
      },
    );

    await this.reply(
      contact,
      [
        '🎙 Səsli reklam mətni qəbul edildi.',
        '',
        voiceText,
        '',
        '🔊 Səs faylı hazırlanır...',
      ].join('\n'),
      {
        task: 'voice-ad-script',
        brief: voiceText,
        validation: {
          productOrService:
            adValidation.productOrService,
          goal:
            adValidation.goal,
        },
      },
    );

    try {
      const speech =
        await this.ai.synthesizeSpeech(
          voiceText,
          'Azərbaycan dili',
        );

      const messageId =
        await this.whatsapp.sendAudio(
          contact.waId,
          speech.bytes,
          speech.mimeType,
          speech.filename,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'audio',
        content: {
          provider:
            speech.provider,
          task:
            'voice-ad',
          text:
            voiceText,
          productOrService:
            adValidation.productOrService,
          goal:
            adValidation.goal,
        },
        status: 'sent',
      });
    } catch (error) {
      this.logger.warn(
        `Voice ad speech generation failed: ${this.errorMessage(
          error,
        )}`,
      );

      await this.reply(
        contact,
        'Mətn qəbul edildi, amma səs faylı yaradıla bilmədi. Bir az sonra yenidən yoxlayın.',
      );
    }

    await this.sendQuickActions(
      contact,
    );
  } catch (error) {
    this.logger.warn(
      `Voice ad generation failed: ${this.errorMessage(
        error,
      )}`,
    );

    await this.reply(
      contact,
      'Səsli reklam hazırda yaradıla bilmədi. Mətni bir az sonra yenidən göndərin.',
    );

    await this.sendQuickActions(
      contact,
    );
  }
}
private async createVideoJob(
  contact: Contact,
  rawText: string,
): Promise<void> {
  if (!(await this.ensureVideoAccess(contact))) {
    return;
  }

  const maxLength =
    this.config.get<number>(
      'MAX_PROMPT_LENGTH',
    ) ?? 1000;

  if (rawText.length < 5) {
    await this.reply(
      contact,
      'Təsviri bir az daha ətraflı yazın — minimum 5 simvol.',
    );
    return;
  }

  if (rawText.length > maxLength) {
    await this.reply(
      contact,
      `Təsvir maksimum ${maxLength} simvol ola bilər.`,
    );
    return;
  }

  if (
    await this.dataStore.hasActiveJob(
      contact.id,
    )
  ) {
    await this.reply(
      contact,
      'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.',
    );
    return;
  }

  const dailyVideoLimit =
    this.config.get<number>(
      'DAILY_VIDEO_LIMIT',
    ) ?? 5;

  const last24Hours =
    new Date(
      Date.now() -
        24 * 60 * 60 * 1000,
    );

  const recentJobCount =
    await this.dataStore.countRecentJobs(
      contact.id,
      last24Hours,
    );

  if (
    recentJobCount >=
    dailyVideoLimit
  ) {
    await this.reply(
      contact,
      [
        '⏳ Gündəlik video limitiniz tamamlanıb.',
        '',
        `Son 24 saat ərzində maksimum ${dailyVideoLimit} reklam videosu hazırlamaq olar.`,
        '',
        'Limit əvvəlki videoların vaxtı keçdikcə avtomatik yenilənəcək.',
      ].join('\n'),
    );

    return;
  }

  const videoCooldownSeconds =
    this.config.get<number>(
      'VIDEO_COOLDOWN_SECONDS',
    ) ?? 60;

  const latestJob =
    await this.dataStore.getLatestJob(
      contact.id,
    );

  if (latestJob) {
    const elapsedSeconds =
      Math.floor(
        (
          Date.now() -
          new Date(
            latestJob.createdAt,
          ).getTime()
        ) / 1000,
      );

    if (
      elapsedSeconds <
      videoCooldownSeconds
    ) {
      const remainingSeconds =
        videoCooldownSeconds -
        elapsedSeconds;

      await this.reply(
        contact,
        [
          '⏳ Yeni reklam yaratmaq üçün bir az gözləyin.',
          '',
          `Təxminən ${remainingSeconds} saniyə sonra yenidən cəhd edə bilərsiniz.`,
        ].join('\n'),
      );

      return;
    }
  }

  if (!contact.pendingImagePath) {
    await this.reply(
      contact,
      'Video üçün əvvəlcə məhsul şəklini göndərin.',
    );
    return;
  }

  const selectedDuration =
    contact.selectedVideoDurationSeconds ?? 10;

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        selectedDuration / 10,
      ),
    );

  const isLongVideo =
    selectedDuration > 10;

  const adValidation =
    await this.ai.validateAdvertisementRequest(
      rawText,
    );

  if (!adValidation.isAdvertisement) {
    await this.reply(
      contact,
      [
        '🚫 Bu sorğu reklam videosu kimi qəbul edilmədi.',
        '',
        'AdYarat yalnız məhsul, xidmət, biznes, brend, kampaniya və digər reklam məqsədli videolar hazırlayır.',
        '',
        'Məsələn belə yazın:',
        '“Bu fincan üçün premium məhsul reklamı hazırla.”',
        '',
        `Səbəb: ${adValidation.reason}`,
      ].join('\n'),
    );

    return;
  }

  const referenceImage =
    await this.mediaStore.get(
      contact.pendingImagePath,
    );

  const imagePromptValidation =
    await this.ai.validateAdvertisementImagePrompt(
      referenceImage,
      contact.pendingImageMime ??
        'image/jpeg',
      rawText,
    );

  if (
    !imagePromptValidation.isRelevant
  ) {
    await this.reply(
      contact,
      [
        '🚫 Yazdığınız reklam təsviri göndərdiyiniz şəkillə uyğun deyil.',
        '',
        'Video təsviri şəkildəki məhsul, xidmət və ya bizneslə əlaqəli olmalıdır.',
        '',
        `Səbəb: ${imagePromptValidation.reason}`,
        '',
        'Məsələn:',
        '“Bu məhsulu premium reklam üslubunda göstər, kamera yavaş-yavaş yaxınlaşsın.”',
      ].join('\n'),
    );

    return;
  }

  const prompt =
    await this.ai.enhanceVideoPrompt(
      rawText,
    );

  await this.dataStore.createJob({
    contactId: contact.id,

    provider:
      this.config.get<string>(
        'VIDEO_PROVIDER',
      ) ?? 'mock',

    prompt,

    inputStoragePath:
      contact.pendingImagePath,

    inputMimeType:
      contact.pendingImageMime ??
      'image/jpeg',

    videoMode:
      isLongVideo
        ? 'long'
        : 'single',

    targetDurationSeconds:
      selectedDuration,

    sceneCount,

    sourceImagePaths:
      contact.pendingImagePaths?.length
        ? contact.pendingImagePaths
        : [
            contact.pendingImagePath,
          ],

    sourceImageMimes:
      contact.pendingImageMimes?.length
        ? contact.pendingImageMimes
        : [
            contact.pendingImageMime ??
              'image/jpeg',
          ],
  });

  await this.dataStore.updateContact(
    contact.id,
    {
      state: 'processing',
    },
  );

  await this.reply(
    contact,
    [
      'Sorğunuz qəbul edildi 🎬',
      '',
      `${selectedDuration} saniyəlik video hazırlanır.`,
      `Video ${sceneCount} ayrı 10 saniyəlik səhnə kimi yaradılacaq və avtomatik birləşdiriləcək.`,
      '',
      'Hazır olduqda bu söhbətə göndərəcəyəm.',
    ].join('\n'),
  );
}

  private async cancelVideoFlow(
    contact: Contact,
  ): Promise<void> {
    if (
      await this.dataStore.hasActiveJob(
        contact.id,
      )
    ) {
      await this.reply(
        contact,
        'Video artıq hazırlanır və bu mərhələdə dayandırıla bilmir.',
      );

      await this.sendQuickActions(contact);
      return;
    }

    await this.dataStore.updateContact(
      contact.id,
      {
        state: 'new',
        pendingImagePath: undefined,
        pendingImageMime: undefined,
      },
    );

    await this.reply(
      contact,
      'Video sorğusu ləğv edildi. Əsas menyudan yeni xidmət seçə bilərsiniz.',
    );

    await this.sendQuickActions(contact);
  }

  private async sendStatus(
    contact: Contact,
  ): Promise<void> {
    const job =
      await this.dataStore.getLatestJob(
        contact.id,
      );

    if (!job) {
      await this.reply(
        contact,
        'Aktiv video sorğunuz yoxdur.',
      );

      await this.sendQuickActions(contact);
      return;
    }

    const labels: Record<string, string> = {
      queued: 'növbədədir ⏳',
      processing: 'hazırlanır 🎬',
      completed: 'hazırdır ✅',
      failed: 'xəta ilə dayandı ❌',
    };

    await this.reply(
      contact,
      `Son video sorğunuz: ${
        labels[job.status] ?? job.status
      }`,
    );

    await this.sendQuickActions(contact);
  }

  private async ensureVideoAccess(
    contact: Contact,
  ): Promise<boolean> {
    if (
      !contact.freeVideoUsed ||
      this.isUnlimitedPilotContact(
        contact.waId,
      )
    ) {
      return true;
    }

    await this.reply(
      contact,
      [
        'Pulsuz nümunə video haqqınız artıq istifadə olunub 🎬',
        '',
        'Yeni reklam videosu sifariş etmək üçün “Paketlər və sifariş” bölməsinə keçin və ya Dəstək seçin.',
        'Onlayn ödəniş sistemi aktiv edilənədək sifarişlər dəstək vasitəsilə qəbul olunur.',
      ].join('\n'),
    );

    await this.sendMainMenu(contact);

    return false;
  }

  private async startSupportFlow(
    contact: Contact,
  ): Promise<void> {
    await this.dataStore.updateContact(
      contact.id,
      {
        state: 'awaiting_support_message',
      },
    );

    await this.reply(
      contact,
      [
        '💬 AdYarat dəstək',
        '',
        'Qarşılaşdığınız problemi bir mesajda ətraflı yazın.',
        'Məsələn: “Video sifariş etdim, amma nəticə gəlmədi.”',
        '',
        'Müraciətiniz birbaşa dəstək əməkdaşına göndəriləcək.',
      ].join('\n'),
    );
  }

  private async submitSupportRequest(
    contact: Contact,
    problem: string,
  ): Promise<void> {
    if (problem.length < 5) {
      await this.reply(
        contact,
        'Problemi bir az daha ətraflı yazın — minimum 5 simvol.',
      );
      return;
    }

    if (problem.length > 2000) {
      await this.reply(
        contact,
        'Dəstək müraciəti maksimum 2000 simvol ola bilər.',
      );
      return;
    }

    const supportWaId = this.supportWaId();

    if (!supportWaId) {
      this.logger.error(
        'SUPPORT_WA_ID is not configured',
      );

      await this.reply(
        contact,
        'Dəstək xidməti hazırda əlçatan deyil. Bir az sonra yenidən yoxlayın.',
      );
      return;
    }

    const customerReference = contact.waId;

    const numericCustomer =
      this.normalizeWaId(customerReference);

    const directLink =
      /^\d{7,15}$/.test(numericCustomer)
        ? `\nBirbaşa yazmaq: https://wa.me/${numericCustomer}`
        : '';

    const notification = [
      '🆘 YENİ DƏSTƏK MÜRACİƏTİ',
      '',
      `Müştəri: ${
        contact.profileName ??
        'Adsız istifadəçi'
      }`,
      `İstifadəçi ID: ${customerReference}${directLink}`,
      '',
      'Problem:',
      problem,
      '',
      'Bot vasitəsilə cavab vermək üçün:',
      `/cavab ${customerReference} cavabınızı buraya yazın`,
    ].join('\n');

    try {
      const messageId =
        await this.whatsapp.sendText(
          supportWaId,
          notification,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'support-notification',
        content: {
          supportWaId,
          customerWaId:
            customerReference,
          problem,
        },
        status: 'sent',
      });

      await this.dataStore.updateContact(
        contact.id,
        {
          state: 'new',
        },
      );

      await this.reply(
        contact,
        [
          'Müraciətiniz dəstək əməkdaşına göndərildi ✅',
          'Cavab bu WhatsApp söhbətinə gələcək.',
          '',
          'Qeyd: sərbəst mətnlə cavab ala bilmək üçün müraciətdən sonrakı 24 saat ərzində bu söhbəti aktiv saxlayın.',
        ].join('\n'),
      );

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.error(
        `Support notification failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        'Müraciət dəstəyə göndərilə bilmədi. Bir az sonra eyni mətni yenidən göndərin.',
      );
    }
  }

  private async handleSupportReply(
    operator: Contact,
    rawText: string,
  ): Promise<void> {
    const match = rawText.match(
      /^(?:\/)?cavab\s+(\S+)\s+([\s\S]+)$/iu,
    );

    if (!match) {
      await this.reply(
        operator,
        'Cavab formatı düzgün deyil. Belə yazın:\n/cavab İSTİFADƏÇİ_ID cavab mətniniz',
      );
      return;
    }

    const [, customerWaId, answer] =
      match;

    const customer =
      await this.dataStore.getContactByWaId(
        customerWaId,
      );

    if (!customer) {
      await this.reply(
        operator,
        `İstifadəçi tapılmadı: ${customerWaId}`,
      );
      return;
    }

    if (answer.trim().length < 2) {
      await this.reply(
        operator,
        'Cavab mətnini də əlavə edin.',
      );
      return;
    }

    try {
      const text =
        `💬 AdYarat dəstək cavabı:\n\n` +
        answer.trim();

      const messageId =
        await this.whatsapp.sendText(
          customer.waId,
          text,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: customer.id,
        direction: 'outbound',
        type: 'text',
        content: {
          text,
          task: 'support-reply',
          operatorWaId: operator.waId,
        },
        status: 'sent',
      });

      await this.reply(
        operator,
        `Cavab ${
          customer.profileName ??
          customer.waId
        } üçün göndərildi ✅`,
      );
    } catch (error) {
      this.logger.error(
        `Support reply failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        operator,
        'Cavab göndərilmədi. İstifadəçinin 24 saatlıq mesaj pəncərəsi bağlanmış ola bilər.',
      );
    }
  }

  private isSupportOperator(
    waId: string,
  ): boolean {
    const supportWaId = this.supportWaId();

    return Boolean(
      supportWaId &&
        this.normalizeWaId(waId) ===
          this.normalizeWaId(supportWaId),
    );
  }

  private supportWaId():
    | string
    | undefined {
    const value =
      this.config
        .get<string>('SUPPORT_WA_ID')
        ?.trim();

    return value
      ? this.normalizeWaId(value)
      : undefined;
  }

  private isUnlimitedPilotContact(
    waId: string,
  ): boolean {
    const configured =
      this.config.get<string>(
        'PILOT_UNLIMITED_WA_IDS',
      ) ?? '';

    const normalizedWaId =
      this.normalizeWaId(waId);

    return configured
      .split(',')
      .map((item) =>
        this.normalizeWaId(item),
      )
      .filter(Boolean)
      .includes(normalizedWaId);
  }

  private normalizeWaId(
    value: string,
  ): string {
    return value
      .trim()
      .replace(/^\+/, '');
  }

  private async conversationHistory(
    contactId: string,
    currentMessageId: string,
  ): Promise<AiConversationTurn[]> {
    const messages =
      await this.dataStore.getRecentMessages(
        contactId,
        12,
      );

    return messages
      .filter(
        (message) =>
          message.waMessageId !==
            currentMessageId &&
          message.type === 'text',
      )
      .map((message) =>
        this.toConversationTurn(message),
      )
      .filter(
        (
          turn,
        ): turn is AiConversationTurn =>
          Boolean(turn),
      )
      .slice(-8);
  }

  private toConversationTurn(
    message: ConversationMessage,
  ): AiConversationTurn | undefined {
    if (
      !message.content ||
      typeof message.content !== 'object'
    ) {
      return undefined;
    }

    const content =
      message.content as {
        text?:
          | string
          | {
              body?: string;
            };
      };

    const text =
      typeof content.text === 'string'
        ? content.text
        : typeof content.text?.body ===
            'string'
          ? content.text.body
          : undefined;

    if (!text?.trim()) {
      return undefined;
    }

    return {
      role:
        message.direction === 'inbound'
          ? 'user'
          : 'assistant',
      text: text.trim(),
    };
  }

  private async reply(
    contact: Contact,
    text: string,
    metadata: Record<
      string,
      unknown
    > = {},
  ): Promise<void> {
    const maxLength = Math.min(
      this.config.get<number>(
        'AI_MAX_REPLY_CHARS',
      ) ?? 3500,
      4000,
    );

    for (const part of splitText(
      text,
      maxLength,
    )) {
      const messageId =
        await this.whatsapp.sendText(
          contact.waId,
          part,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'text',
        content: {
          text: part,
          ...metadata,
        },
        status: 'sent',
      });
    }
  }

  private async sendMainMenu(
    contact: Contact,
  ): Promise<void> {
    const messageId =
      await this.whatsapp.sendMainMenu(
        contact.waId,
        contact.profileName,
      );

    await this.dataStore.recordMessage({
      waMessageId: messageId,
      contactId: contact.id,
      direction: 'outbound',
      type: 'interactive',
      content: {
        menu: 'main',
      },
      status: 'sent',
    });
  }

  private async sendAdTypeMenu(
    contact: Contact,
  ): Promise<void> {
    const messageId =
      await this.whatsapp.sendAdTypeMenu(
        contact.waId,
      );

    await this.dataStore.recordMessage({
      waMessageId: messageId,
      contactId: contact.id,
      direction: 'outbound',
      type: 'interactive',
      content: {
        menu: 'ad-types',
      },
      status: 'sent',
    });
  }

  private async sendQuickActions(
    contact: Contact,
  ): Promise<void> {
    try {
      const messageId =
        await this.whatsapp.sendQuickActions(
          contact.waId,
        );

      await this.dataStore.recordMessage({
        waMessageId: messageId,
        contactId: contact.id,
        direction: 'outbound',
        type: 'interactive',
        content: {
          menu: 'quick-actions',
        },
        status: 'sent',
      });
    } catch (error) {
      this.logger.warn(
        `Could not send quick actions: ${this.errorMessage(error)}`,
      );
    }
  }

  private imageExtension(
    mimeType: string,
  ): string {
    if (mimeType === 'image/png') {
      return 'png';
    }

    if (mimeType === 'image/webp') {
      return 'webp';
    }

    return 'jpg';
  }

  private audioExtension(
    mimeType: string,
  ): string {
    if (mimeType.includes('mpeg')) {
      return 'mp3';
    }

    if (mimeType.includes('mp4')) {
      return 'm4a';
    }

    if (mimeType.includes('wav')) {
      return 'wav';
    }

    if (mimeType.includes('webm')) {
      return 'webm';
    }

    return 'ogg';
  }

  private publicError(
    error: unknown,
  ): string {
    const message =
      this.errorMessage(error);

    return message.length <= 500
      ? message
      : 'Texniki xəta baş verdi. Sonra yenidən yoxlayın.';
  }

  private errorMessage(
    error: unknown,
  ): string {
    return error instanceof Error
      ? error.message
      : String(error);
  }
}
