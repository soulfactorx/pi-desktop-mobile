/**
 * 텔레그램 Bot API의 아주 작은 클라이언트 (https://core.telegram.org/bots/api).
 * PC에서 바깥으로만 연결한다(롱폴링). 공개 주소·포트를 열 필요가 없다.
 * 시험할 때는 PI_DESKTOP_MATE_TELEGRAM_API로 가짜 서버 주소를 준다.
 */
export const TELEGRAM_API_ENV = "PI_DESKTOP_MATE_TELEGRAM_API";
export const TELEGRAM_TOKEN_ENV = "PI_DESKTOP_MATE_TELEGRAM_TOKEN";

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; first_name?: string; username?: string };
    text?: string;
    /** 답장한 메시지 (Mate 질문에 답장하면 그 질문의 답으로 본다) */
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly base: string = process.env[TELEGRAM_API_ENV] || "https://api.telegram.org",
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !body.ok) throw new Error(`텔레그램 ${method} 실패: ${body.description ?? `HTTP ${res.status}`}`);
    return body.result as T;
  }

  getMe(): Promise<{ username: string }> {
    return this.call("getMe");
  }

  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call("getUpdates", { ...(offset ? { offset } : {}), timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal);
  }

  sendMessage(chatId: number, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<{ message_id: number }> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  editButtons(chatId: number, messageId: number, buttons: Array<Array<{ text: string; callback_data: string }>>): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
  }

  /** "입력 중…" 표시 (몇 초 동안) */
  typing(chatId: number): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
