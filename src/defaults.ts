import type { BotConfig, CalendarSlot } from "./types";

export const DEFAULT_CONFIG: BotConfig = {
  systemPrompt:
    "Ты ассистент психолога-консультанта в Telegram. Аудитория: взрослые люди с РАС, СДВГ, нейроотличностью или подозрением на нейроотличность. Отвечай бережно, прямо, понятно. Не ставь диагноз. Не обещай лечение. При готовности клиента предложи запись.",
  crisisPrompt:
    "Если сообщение содержит риск самоповреждения, суицидальные намерения, угрозу жизни или острое состояние, не консультируй. Направь человека в экстренные службы, к врачу или к человеку рядом. Формат психолога не является экстренной помощью.",
  services: [
    {
      id: "intro_15",
      title: "15 минут: первичное знакомство",
      durationMinutes: 15,
      description: "Короткая проверка формата: подходит ли консультация и какой следующий шаг."
    },
    {
      id: "consultation",
      title: "Индивидуальная онлайн-консультация",
      durationMinutes: 60,
      description: "Разбор запроса, связанного с РАС, СДВГ, адаптацией, эмоциями и бытом."
    }
  ],
  prices: [
    { serviceId: "intro_15", amount: 0, currency: "RUB", note: "Бесплатно" },
    { serviceId: "consultation", amount: 5000, currency: "RUB", note: "Первый час; продление +500 RUB за 30 минут; максимум 7000 RUB." }
  ],
  memory: {
    shortTermDays: 7,
    longTermProfileEnabled: true,
    maxRecentMessages: 12
  },
  searchEnabled: true
};

export const DEFAULT_SLOTS: CalendarSlot[] = [
  {
    id: "slot_demo_1",
    startsAt: "2026-05-22T10:00:00+03:00",
    endsAt: "2026-05-22T10:15:00+03:00",
    status: "free",
    source: "manual"
  },
  {
    id: "slot_demo_2",
    startsAt: "2026-05-22T18:00:00+03:00",
    endsAt: "2026-05-22T19:00:00+03:00",
    status: "free",
    source: "manual"
  }
];
