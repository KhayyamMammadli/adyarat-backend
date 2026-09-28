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
