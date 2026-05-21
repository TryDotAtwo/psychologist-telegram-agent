export type BotConfig = {
  systemPrompt: string;
  crisisPrompt: string;
  services: ServiceConfig[];
  prices: PriceConfig[];
  memory: MemoryConfig;
  searchEnabled: boolean;
};

export type ServiceConfig = {
  id: string;
  title: string;
  durationMinutes: number;
  description: string;
};

export type PriceConfig = {
  serviceId: string;
  amount: number;
  currency: string;
  note: string;
};

export type MemoryConfig = {
  shortTermDays: number;
  longTermProfileEnabled: boolean;
  maxRecentMessages: number;
};

export type CalendarSlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "free" | "held" | "booked";
  source: "manual" | "google_calendar_cache";
  clientChatId?: string;
};

export type ClientRiskLevel = "none" | "watch" | "urgent";

export type ClientSummary = {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  lastMessageAt: string;
  lastUserText?: string;
  lastAssistantText?: string;
  messageCount: number;
  tags: string[];
  facts: string[];
  reminders: string[];
  riskLevel: ClientRiskLevel;
  nextAction?: string;
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  source?: "bot" | "admin" | "telegram";
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: number; username?: string; first_name?: string; last_name?: string };
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type Env = {
  ASSETS: Fetcher;
  BOT_OBJECTS?: R2Bucket;
  CHAT_MEMORY: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  ADMIN_PASSWORD?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_BASE_URL?: string;
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ADMIN_EMAIL?: string;
  TIMEZONE: string;
  PUBLIC_BOT_NAME: string;
};
