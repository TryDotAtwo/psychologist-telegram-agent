import type { CalendarSlot, Env } from "./types";

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
          [{ text: "Записаться" }, { text: "Свободные слоты" }],
          [{ text: "Цены" }, { text: "Задать вопрос" }]
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

export function formatSlots(slots: CalendarSlot[]): string {
  if (slots.length === 0) return "Свободных слотов пока нет. Администратор добавит время в расписание.";
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
  return `Ближайшие свободные окна:\n\n${lines.join("\n")}\n\nДля записи напишите: <b>бронь 1</b>, <b>бронь 2</b> или <b>бронь 3</b>.`;
}

function capitalize(value: string): string {
  return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
