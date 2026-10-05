export type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};
export type ReplyMarkup = InlineKeyboard | { force_reply: true; selective?: boolean };
export type TelegramMessage = {
  message_id?: number;
  from?: { id?: number; is_bot?: boolean };
  chat?: { id?: number; type?: string };
  text?: string;
  reply_to_message?: { message_id?: number };
};
export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id?: number; is_bot?: boolean };
    message?: TelegramMessage;
    data?: string;
  };
};
export type AdminActor = { chatId: number; userId: number; group: boolean };
