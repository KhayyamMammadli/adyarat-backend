import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { WhatsAppProcessorService } from '../dist/whatsapp/whatsapp-processor.service.js';

function textMessage(id, body) {
  return {
    from: '994501234567',
    id,
    timestamp: '1',
    type: 'text',
    text: { body },
  };
}

function interactiveMessage(id, choiceId) {
  return {
    from: '994501234567',
    id,
    timestamp: '1',
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: { id: choiceId, title: choiceId },
    },
  };
}

function payload(message) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [
                {
                  wa_id: message.from,
                  profile: { name: 'Ayla' },
                },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function createHarness() {
  const contact = {
    id: 'contact-1',
    waId: '994501234567',
    profileName: 'Ayla',
    state: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const state = {
    sentTexts: [],
    mainMenus: [],
    adTypeMenus: [],
    quickActions: [],
    sentAudios: [],
    contactUpdates: [],
    recordedMessages: [],
    aiRequests: [],
  };

  let outboundSequence = 0;

  const dataStore = {
    updateMessageStatus: async () => undefined,

    getOrCreateContact: async (_waId, profileName) => {
      if (profileName) {
        contact.profileName = profileName;
      }

      return { ...contact };
    },

    recordMessage: async (message) => {
      state.recordedMessages.push(message);
      return true;
    },

    updateContact: async (_contactId, patch) => {
      state.contactUpdates.push(patch);

      Object.assign(contact, patch, {
        updatedAt: new Date().toISOString(),
      });

      return { ...contact };
    },

    hasActiveJob: async () => false,
    getLatestJob: async () => undefined,
    getRecentMessages: async () => [],
    createJob: async () => undefined,
  };

  const whatsapp = {
    markAsRead: async () => undefined,

    sendText: async (_waId, text) => {
      state.sentTexts.push(text);
      return `out-text-${++outboundSequence}`;
    },

    sendMainMenu: async (waId, profileName) => {
      state.mainMenus.push({ waId, profileName });
      return `out-main-menu-${++outboundSequence}`;
    },

    sendAdTypeMenu: async (waId) => {
      state.adTypeMenus.push(waId);
      return `out-ad-menu-${++outboundSequence}`;
    },

    sendQuickActions: async (waId) => {
      state.quickActions.push(waId);
      return `out-quick-${++outboundSequence}`;
    },

    sendAudio: async (
      waId,
      bytes,
      mimeType,
      filename,
    ) => {
      state.sentAudios.push({
        waId,
        bytes,
        mimeType,
        filename,
      });

      return `out-audio-${++outboundSequence}`;
    },
  };

  const ai = {
    answer: async (request) => {
      state.aiRequests.push(request);

      return {
        provider: 'gemini',
        text: request.systemInstruction?.includes('diktor')
          ? 'Məhsulunuz üçün yaddaqalan və təsirli səsli reklam.'
          : '🎯 Başlıq: Daha yaxşı seçim\n📝 Reklam mətni: Məhsulunuzu bu gün kəşf edin.',
      };
    },

    synthesizeSpeech: async () => ({
      provider: 'openai',
      bytes: Buffer.from('audio'),
      mimeType: 'audio/mpeg',
      filename: 'adyarat-voice-ad.mp3',
    }),

    enhanceVideoPrompt: async (text) => text,
  };

  const processor = new WhatsAppProcessorService(
    new ConfigService({}),
    dataStore,
    {
      put: async () => undefined,
    },
    whatsapp,
    ai,
    {},
  );

  return {
    processor,
    contact,
    state,
  };
}

test(
  'opens the main advertising menu when a new user writes a normal message',
  async () => {
    const { processor, state } = createHarness();

    await processor.process(
      payload(textMessage('wamid.1', 'Salam')),
    );

    assert.deepEqual(state.mainMenus, [
      {
        waId: '994501234567',
        profileName: 'Ayla',
      },
    ]);

    assert.equal(state.aiRequests.length, 0);
  },
);

test(
  'opens the advertising type menu from the new advertising button',
  async () => {
    const { processor, state } = createHarness();

    await processor.process(
      payload(
        interactiveMessage(
          'wamid.2',
          'menu_create_ad',
        ),
      ),
    );

    assert.deepEqual(
      state.adTypeMenus,
      ['994501234567'],
    );
  },
);

test(
  'creates advertising copy and returns the contact to the main state',
  async () => {
    const { processor, contact, state } =
      createHarness();

    await processor.process(
      payload(
        interactiveMessage('wamid.3', 'ad_copy'),
      ),
    );

    assert.equal(
      contact.state,
      'awaiting_ad_copy_brief',
    );

    await processor.process(
      payload(
        textMessage(
          'wamid.4',
          'Bakıda çatdırılma ilə təbii qəhvə satırıq, əsas üstünlük təzə qovrulmasıdır.',
        ),
      ),
    );

    assert.equal(contact.state, 'new');
    assert.equal(state.aiRequests.length, 1);

    assert.match(
      state.sentTexts.at(-1),
      /Reklam mətniniz hazırdır/,
    );

    assert.deepEqual(
      state.quickActions,
      ['994501234567'],
    );
  },
);

test(
  'creates a voice advertising script and sends the generated audio',
  async () => {
    const { processor, contact, state } =
      createHarness();

    await processor.process(
      payload(
        interactiveMessage('wamid.5', 'ad_voice'),
      ),
    );

    assert.equal(
      contact.state,
      'awaiting_voice_ad_brief',
    );

    await processor.process(
      payload(
        textMessage(
          'wamid.6',
          'Yeni açılmış gözəllik salonu üçün qadınlara yönəlmiş qısa və premium reklam hazırla.',
        ),
      ),
    );

    assert.equal(contact.state, 'new');
    assert.equal(state.sentAudios.length, 1);

    assert.equal(
      state.sentAudios[0].mimeType,
      'audio/mpeg',
    );

    assert.equal(
      state.sentAudios[0].filename,
      'adyarat-voice-ad.mp3',
    );

    assert.deepEqual(
      state.quickActions,
      ['994501234567'],
    );
  },
);