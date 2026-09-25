async sendQuickActions(to: string): Promise<string> {
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
