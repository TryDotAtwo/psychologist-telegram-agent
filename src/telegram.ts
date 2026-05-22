import type { AvailabilityWindow, Env } from "./types";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

export type TelegramWebhookInfo = {
  url: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
};

export async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          [{ text: "Записаться" }, { text: "Свободные окна" }],
          [{ text: "Цены" }, { text: "Связаться с психологом" }]
        ],
        resize_keyboard: true
      }
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`telegram_send_status=${response.status}; body=${body.slice(0, 300)}`);
  }
}

export async function sendTelegramChatAction(env: Env, chatId: string, action = "typing"): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`telegram_chat_action_status=${response.status}; body=${body.slice(0, 300)}`);
  }
}

export async function getTelegramWebhookInfo(env: Env): Promise<TelegramApiResponse<TelegramWebhookInfo>> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const payload = (await response.json()) as TelegramApiResponse<TelegramWebhookInfo>;
  if (!response.ok || !payload.ok) {
    return {
      ok: false,
      error_code: payload.error_code ?? response.status,
      description: payload.description ?? `telegram_getWebhookInfo_status=${response.status}`
    };
  }
  return payload;
}

export async function setTelegramWebhook(env: Env, url: string): Promise<TelegramApiResponse<boolean>> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    })
  });
  const payload = (await response.json()) as TelegramApiResponse<boolean>;
  if (!response.ok || !payload.ok) {
    return {
      ok: false,
      error_code: payload.error_code ?? response.status,
      description: payload.description ?? `telegram_setWebhook_status=${response.status}`
    };
  }
  return payload;
}

export function formatAvailability(slots: AvailabilityWindow[], durationMinutes: number, returningClient: boolean): string {
  if (slots.length === 0) {
    return "Свободных окон пока нет. Психолог обновит рабочие часы или освободит время в календаре.";
  }
  const lines = slots.map((slot, index) => {
    const start = new Date(slot.startsAt);
    const end = new Date(slot.endsAt);
    const day = new Intl.DateTimeFormat("ru-RU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/Moscow"
    }).format(start);
    const startTime = new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Moscow"
    }).format(start);
    const endTime = new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Moscow"
    }).format(end);
    return `${index + 1}. ${capitalize(day)}, ${startTime}-${endTime}`;
  });
  const durationNote = returningClient
    ? `Я подобрал окна на ${durationMinutes} минут по обычной длительности ваших встреч. Если нужна другая длительность, напишите: длительность 90.`
    : `Для первой бесплатной встречи я показываю окна на ${durationMinutes} минут.`;
  return `Ближайшие свободные окна:\n\n${lines.join("\n")}\n\n${durationNote}\n\nДля записи напишите: <b>бронь 1</b>, <b>бронь 2</b> или <b>бронь 3</b>.`;
}

export function escapeTelegramHtml(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return value.replace(/[&<>]/g, (char) => map[char] ?? char);
}

function capitalize(value: string): string {
  return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
