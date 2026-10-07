export type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};
export type ReplyMarkup =
  | InlineKeyboard
  | { force_reply: true; selective?: boolean }
  | {
      keyboard: Array<Array<{ text: string }>>;
      resize_keyboard: boolean;
      is_persistent: boolean;
      one_time_keyboard: boolean;
    };
export type TelegramMessage = {
  message_id?: number;
  from?: { id?: number; is_bot?: boolean };
  chat?: { id?: number; type?: string };
  text?: string;
  location?: { latitude: number; longitude: number };
  venue?: { location: { latitude: number; longitude: number }; title?: string; address?: string };
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
export type AdminActor = {
  chatId: number;
  userId: number;
  group: boolean;
  role?: 'superadmin' | 'admin' | 'moderator';
  permissions?: import('./staff-permissions').StaffPermission[];
};
