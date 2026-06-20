import type { BotConfig, WorkSchedule } from "./types";

export const DEFAULT_CONFIG: BotConfig = {
  systemPrompt:
    "Ты ассистент психолога-консультанта в Telegram. Аудитория: взрослые люди с РАС, СДВГ, нейроотличностью или подозрением на нейроотличность. Отвечай бережно, прямо и понятно. Не ставь диагноз. Не обещай лечение. При готовности клиента предложи запись. Запоминай только факты, которые клиент явно сообщил. Медицинские данные помечай как слова клиента, а не как подтвержденный диагноз.",
  crisisPrompt:
    "Если сообщение содержит риск самоповреждения, суицидальные намерения, угрозу жизни или острое состояние, не консультируй. Предложи немедленно обратиться в экстренные службы, к врачу или к человеку рядом. Формат психолога не является экстренной помощью.",
  services: [
    {
      id: "intro_30",
      title: "30 минут: бесплатное знакомство",
      durationMinutes: 30,
      description: "Первая короткая встреча для нового клиента: понять запрос, формат и следующий шаг."
    },
    {
      id: "consultation",
      title: "Индивидуальная онлайн-консультация",
      durationMinutes: 60,
      description: "Работа с запросом, связанным с РАС, СДВГ, адаптацией, эмоциями, бытом и коммуникацией."
    }
  ],
  prices: [
    { serviceId: "intro_30", amount: 0, currency: "RUB", note: "Первое знакомство бесплатно" },
    { serviceId: "consultation", amount: 5000, currency: "RUB", note: "60 минут; продление обсуждается отдельно" }
  ],
  memory: {
    shortTermDays: 7,
    longTermProfileEnabled: true,
    maxRecentMessages: 12
  },
  searchEnabled: true
};

export const DEFAULT_SCHEDULE: WorkSchedule = {
  timezone: "Europe/Moscow",
  slotStepMinutes: 30,
  introDurationMinutes: 30,
  defaultSessionMinutes: 60,
  weeklyTemplate: {
    mon: [{ start: "12:00", end: "20:00" }],
    tue: [{ start: "12:00", end: "20:00" }],
    wed: [{ start: "12:00", end: "20:00" }],
    thu: [{ start: "12:00", end: "20:00" }],
    fri: [{ start: "12:00", end: "20:00" }],
    sat: [],
    sun: []
  },
  dateOverrides: {}
};
