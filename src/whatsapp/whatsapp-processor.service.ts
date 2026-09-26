import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiOrchestratorService } from '../ai/ai-orchestrator.service';
import { AiConversationTurn, AiProviderName } from '../ai/ai.types';
import { isVideoIntent, parseProviderCommand, providerLabel, splitText } from '../ai/ai.utils';
import { DocumentTranslationService } from '../ai/document-translation.service';
import { Contact, ConversationMessage } from '../common/domain';
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
    private readonly ai: AiOrchestratorService,
    private readonly documents: DocumentTranslationService,
  ) {}

  async process(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const status of extractStatuses(payload)) {
      await this.dataStore.updateMessageStatus(status.id, status.status);
    }

    for (const envelope of extractMessages(payload)) {
      const { message, profileName } = envelope;

      const contact = await this.dataStore.getOrCreateContact(
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

      await this.whatsapp.markAsRead(message.id).catch((error: unknown) => {
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
    if (message.type === 'image') {
      return this.handleImage(contact, message as WhatsAppImageMessage);
    }

    if (message.type === 'audio') {
      return this.handleAudio(contact, message as WhatsAppAudioMessage);
    }

    if (message.type === 'document') {
      return this.handleDocument(
        contact,
        message as WhatsAppDocumentMessage,
      );
    }

    if (message.type === 'text') {
      return this.handleText(contact, message as WhatsAppTextMessage);
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
    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(
        contact,
        'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.',
      );
      return;
    }

    const media = await this.whatsapp.downloadMedia(message.image.id);

    if (!ALLOWED_IMAGE_TYPES.has(media.mimeType)) {
      await this.reply(
        contact,
        'Şəkil JPG, PNG və ya WEBP formatında olmalıdır.',
      );
      return;
    }

    const maxBytes =
      this.config.get<number>('MAX_IMAGE_BYTES') ?? 5 * 1024 * 1024;

    if (media.fileSize > maxBytes || media.bytes.length > maxBytes) {
      await this.reply(
        contact,
        `Şəkil maksimum ${Math.floor(maxBytes / 1024 / 1024)} MB ola bilər.`,
      );
      return;
    }

    const path =
      `inputs/${contact.waId}/${message.id}.` +
      this.imageExtension(media.mimeType);

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
      ['status', 'vəziyyət', 'veziyyet', '/status'].includes(command)
    ) {
      await this.sendStatus(contact);
      return;
    }

    if (
      ['ləğv', 'legv', 'cancel', '/cancel'].includes(command)
    ) {
      await this.cancelVideoFlow(contact);
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

    if (contact.state === 'awaiting_voice_ad_brief') {
      await this.createVoiceAd(contact, rawText);
      return;
    }

    if (command.startsWith('/ai ')) {
      await this.handleAiChat(
        contact,
        message.id,
        rawText.slice(rawText.indexOf(' ') + 1).trim(),
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
        await this.dataStore.updateContact(contact.id, {
          state: 'awaiting_prompt',
        });
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
      await this.reply(
        contact,
        this.helpText(contact.profileName),
      );

      await this.sendQuickActions(contact);
      return;
    }

    if (
      choiceId === 'ad_video' ||
      choiceId === 'menu_video' ||
      choiceId === 'quick_video'
    ) {
      await this.dataStore.updateContact(contact.id, {
        state: contact.pendingImagePath
          ? 'awaiting_prompt'
          : 'new',
      });

      await this.reply(
        contact,
        contact.pendingImagePath
          ? '🎬 Məhsul şəkliniz hazırdır. İndi videoda nə baş verməsini istədiyinizi yazın.'
          : '🎬 Video reklam üçün məhsul şəklini göndərin. Sonra videoda nə baş verməsini istədiyinizi yazacaqsınız.',
      );
      return;
    }

    if (choiceId === 'ad_copy') {
      await this.dataStore.updateContact(contact.id, {
        state: 'awaiting_ad_copy_brief',
      });

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
      await this.dataStore.updateContact(contact.id, {
        state: 'awaiting_voice_ad_brief',
      });

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

    // Köhnə söhbətlərdə artıq göndərilmiş düymələr üçün.
    if (choiceId === 'menu_ai') {
      await this.reply(
        contact,
        '🤖 Sualınızı belə yazın: /ai sualınız',
      );
      return;
    }

    if (choiceId === 'quick_ai') {
      await this.reply(
        contact,
        '💬 Sualınızı belə yazın: /ai sualınız',
      );
      return;
    }

    if (choiceId === 'menu_gemini') {
      await this.reply(
        contact,
        'Gemini ilə danışmaq üçün belə yazın:\n/gemini sualınız',
      );
      return;
    }

    if (choiceId === 'menu_chatgpt') {
      await this.reply(
        contact,
        'ChatGPT ilə danışmaq üçün belə yazın:\n/chatgpt sualınız',
      );
      return;
    }

    if (choiceId === 'menu_claude') {
      await this.reply(
        contact,
        'Claude ilə danışmaq üçün belə yazın:\n/claude sualınız',
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
        this.config.get<string>('AI_DEFAULT_PROVIDER') ?? 'auto';

      const provider =
        forcedProvider ??
        (configured === 'auto'
          ? undefined
          : (configured as AiProviderName));

      const history = await this.conversationHistory(
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
        contact.state === 'awaiting_voice_ad_brief';

      await this.reply(
        contact,
        isVoiceAdBrief
          ? '🎙 Səsli məlumat alındı. Reklam ssenarisi hazırlanır...'
          : '🎙️ Səs alındı. Mətnə çevirirəm...',
      );

      const media = await this.whatsapp.downloadMedia(
        message.audio.id,
      );

      const maxBytes =
        this.config.get<number>('MAX_AUDIO_BYTES') ??
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
        await this.createVoiceAd(contact, result.text);
        return;
      }

      const translation =
        await this.ai.translateVoiceCommand(result.text);

      if (!translation.shouldTranslate) {
        await this.reply(
          contact,
          [
            '📝 Səsin mətni:',
            '',
            translation.sourceText,
            '',
            'Tərcümə üçün səsin sonunda, məsələn, “bu səsi ingilis dilinə çevir” deyin.',
          ].join('\n'),
          {
            provider: result.provider,
            task: 'transcription',
          },
        );

        await this.sendQuickActions(contact);
        return;
      }

      const targetLanguage = translation.targetLanguage!;
      const translatedText = translation.translatedText!;

      await this.reply(
        contact,
        [
          `🌍 ${targetLanguage} tərcüməsi:`,
          '',
          translatedText,
          '',
          '🔊 Aşağıdakı səs AI tərəfindən yaradılıb.',
        ].join('\n'),
        {
          provider: translation.provider,
          task: 'voice-translation',
          sourceText: translation.sourceText,
          targetLanguage,
        },
      );

      try {
        const speech = await this.ai.synthesizeSpeech(
          translatedText,
          targetLanguage,
        );

        const messageId = await this.whatsapp.sendAudio(
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
          `Translated speech generation failed: ${this.errorMessage(
            error,
          )}`,
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

      const media = await this.whatsapp.downloadMedia(
        message.document.id,
      );

      const translated = await this.documents.translate(
        media.bytes,
        media.mimeType,
        filename,
        message.document.caption,
      );

      const messageId = await this.whatsapp.sendDocument(
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
          sourceCharacters: translated.sourceCharacters,
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
    if (brief.length < 10) {
      await this.reply(
        contact,
        'Məlumatı bir az daha ətraflı yazın. Məhsulun adı, üstünlüyü və kimlər üçün olduğunu qeyd edin.',
      );
      return;
    }

    try {
      await this.reply(
        contact,
        '✍️ Məlumat alındı. Reklam mətniniz hazırlanır...',
      );

      const result = await this.ai.answer({
        text: brief,
        maxOutputTokens: 900,
        systemInstruction: [
          'Sən Azərbaycan bazarı üçün peşəkar reklam kopirayterisən.',
          'İstifadəçinin məhsul və ya xidmət məlumatına əsasən hazır reklam paketi yaz.',
          'Cavab yalnız Azərbaycan dilində olsun.',
          'Bu quruluşu saxla:',
          '🎯 Başlıq:',
          '📝 Reklam mətni:',
          '📣 Çağırış:',
          '📱 Sosial media paylaşımı:',
          '#️⃣ Hashtag-lər:',
          'Fakt uydurma, verilməyən qiymət və kampaniya əlavə etmə.',
        ].join('\n'),
      });

      await this.dataStore.updateContact(contact.id, {
        state: 'new',
      });

      await this.reply(
        contact,
        `✍️ Reklam mətniniz hazırdır:\n\n${result.text}`,
        {
          provider: result.provider,
          task: 'ad-copy',
          brief,
        },
      );

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.warn(
        `Ad copy generation failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        'Reklam mətni hazırda yaradıla bilmədi. Məlumatı bir az sonra yenidən göndərin.',
      );

      await this.sendQuickActions(contact);
    }
  }

  private async createVoiceAd(
    contact: Contact,
    brief: string,
  ): Promise<void> {
    if (brief.length < 10) {
      await this.reply(
        contact,
        'Məlumatı bir az daha ətraflı göndərin. Məhsulun adı, üstünlüyü və təklifinizi qeyd edin.',
      );
      return;
    }

    try {
      await this.reply(
        contact,
        '🎙 Məlumat alındı. Səsli reklamınız hazırlanır...',
      );

      const result = await this.ai.answer({
        text: brief,
        maxOutputTokens: 500,
        systemInstruction: [
          'Sən Azərbaycan bazarı üçün peşəkar reklam ssenaristi və diktor mətn müəllifisən.',
          'Verilən məlumata əsasən 15–30 saniyəlik, təbii və inandırıcı səsli reklam mətni yaz.',
          'Cavab yalnız Azərbaycan dilində, bir qısa abzas şəklində olsun.',
          'Başlıq, izah, səhnə qeydi və hashtag yazma.',
          'Fakt uydurma, verilməyən qiymət və kampaniya əlavə etmə.',
        ].join('\n'),
      });

      await this.dataStore.updateContact(contact.id, {
        state: 'new',
      });

      await this.reply(
        contact,
        [
          '🎙 Səsli reklam mətniniz:',
          '',
          result.text,
          '',
          '🔊 Səs faylı hazırlanır...',
        ].join('\n'),
        {
          provider: result.provider,
          task: 'voice-ad-script',
          brief,
        },
      );

      try {
        const speech = await this.ai.synthesizeSpeech(
          result.text,
          'Azərbaycan dili',
        );

        const messageId = await this.whatsapp.sendAudio(
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
            task: 'voice-ad',
            text: result.text,
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
          'Reklam mətni hazırdır, amma səs faylı yaradıla bilmədi. Bir az sonra yenidən yoxlayın.',
        );
      }

      await this.sendQuickActions(contact);
    } catch (error) {
      this.logger.warn(
        `Voice ad generation failed: ${this.errorMessage(error)}`,
      );

      await this.reply(
        contact,
        'Səsli reklam hazırda yaradıla bilmədi. Məlumatı bir az sonra yenidən göndərin.',
      );

      await this.sendQuickActions(contact);
    }
  }

  private async createVideoJob(
    contact: Contact,
    rawText: string,
  ): Promise<void> {
    const maxLength =
      this.config.get<number>('MAX_PROMPT_LENGTH') ?? 1000;

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

    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(
        contact,
        'Hazırda əvvəlki videonuz hazırlanır. Nəticəni gözləyin.',
      );
      return;
    }

    if (!contact.pendingImagePath) {
      await this.reply(
        contact,
        'Video üçün əvvəlcə məhsul şəklini göndərin.',
      );
      return;
    }

    const prompt =
      await this.ai.enhanceVideoPrompt(rawText);

    await this.dataStore.createJob({
      contactId: contact.id,
      provider:
        this.config.get<string>('VIDEO_PROVIDER') ?? 'mock',
      prompt,
      inputStoragePath: contact.pendingImagePath,
      inputMimeType:
        contact.pendingImageMime ?? 'image/jpeg',
    });

    await this.dataStore.updateContact(contact.id, {
      state: 'processing',
    });

    await this.reply(
      contact,
      'Sorğunuz qəbul edildi 🎬\nVideo hazırlanır. Hazır olduqda bu söhbətə göndərəcəyəm.',
    );
  }

  private async cancelVideoFlow(
    contact: Contact,
  ): Promise<void> {
    if (await this.dataStore.hasActiveJob(contact.id)) {
      await this.reply(
        contact,
        'Video artıq hazırlanır və bu mərhələdə dayandırıla bilmir.',
      );

      await this.sendQuickActions(contact);
      return;
    }

    await this.dataStore.updateContact(contact.id, {
      state: 'new',
      pendingImagePath: undefined,
      pendingImageMime: undefined,
    });

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
      await this.dataStore.getLatestJob(contact.id);

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
          message.waMessageId !== currentMessageId &&
          message.type === 'text',
      )
      .map((message) => this.toConversationTurn(message))
      .filter(
        (turn): turn is AiConversationTurn =>
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

    const content = message.content as {
      text?: string | { body?: string };
    };

    const text =
      typeof content.text === 'string'
        ? content.text
        : typeof content.text?.body === 'string'
          ? content.text.body
          : undefined;

    if (!text?.trim()) return undefined;

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
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const maxLength = Math.min(
      this.config.get<number>('AI_MAX_REPLY_CHARS') ??
        3500,
      4000,
    );

    for (const part of splitText(text, maxLength)) {
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
      await this.whatsapp.sendAdTypeMenu(contact.waId);

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
        `Could not send quick actions: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  private helpText(name?: string): string {
    const greeting = name
      ? `Salam, ${name}! 👋`
      : 'Salam! 👋';

    return [
      greeting,
      'AdYarat məhsul və xidmətlər üçün reklam hazırlayır.',
      '',
      '✨ Yeni reklam — reklam növünü seçin',
      '🎬 Video reklam — məhsul şəklindən qısa reklam videosu',
      '✍️ Reklam mətni — paylaşım üçün hazır reklam yazısı',
      '🎙 Səsli reklam — reklam mətni və səsləndirilmiş audio',
      '📁 Reklamlarım — son video sorğusunun vəziyyəti',
      '',
      'Əsas menyunu istənilən vaxt açmaq üçün MENYU yazın.',
    ].join('\n');
  }

  private imageExtension(
    mimeType: string,
  ): string {
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/webp') return 'webp';
    return 'jpg';
  }

  private audioExtension(
    mimeType: string,
  ): string {
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('webm')) return 'webm';
    return 'ogg';
  }

  private publicError(error: unknown): string {
    const message = this.errorMessage(error);

    return message.length <= 500
      ? message
      : 'Texniki xəta baş verdi. Sonra yenidən yoxlayın.';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : String(error);
  }
}