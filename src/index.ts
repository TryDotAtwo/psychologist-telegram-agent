import { handleAdminApi } from "./admin";
import {
  clientDisplayName,
  holdFreeSlotByPosition,
  holdSlot,
  listAvailability,
  listFreeSlots,
  suggestedDurationForChat
} from "./calendar";
import { appendClientMemoryMarkdown, buildClientConversationContext, refreshClientMemoryProfile, shouldRefreshClientMemoryProfile } from "./client_memory";
import { ChatMemory, memoryStub } from "./memory";
import { answerWithOpenAI } from "./openai";
import { processDueReminders } from "./reminders";
import { appendStoredJsonl, mergedProfile, readConfig, readUsers, upsertClient } from "./storage";
import { formatAvailability, sendTelegramChatAction, sendTelegramMessage } from "./telegram";
import type { ClientSummary, Env, TelegramUpdate } from "./types";

type ConversationContext = { profile: unknown; turns: { role: string; text: string; createdAt: string }[] };
type DayRequest = { label: string; fromIso: string; toIso: string };
const CLIENT_HANDOFF_MS = 24 * 60 * 60 * 1000;
const AI_UNAVAILABLE_FALLBACK = "Агент сейчас недоступен, психологу передали информацию. Извините за доставленные неудобства.";

export { ChatMemory };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/bot/api/")) {
      url.pathname = url.pathname.replace(/^\/bot/, "");
      const nextRequest = new Request(url.toString(), request);
      nextRequest.headers.set("X-Dashboard-Prefix", "/bot");
      return handleAdminApi(nextRequest, env);
    }
    if (url.pathname === "/bot/health") return Response.json({ ok: true, service: env.PUBLIC_BOT_NAME });
    if (url.pathname.startsWith("/api/")) return handleAdminApi(request, env);
    if (url.pathname === "/health") return Response.json({ ok: true, service: env.PUBLIC_BOT_NAME });
    if (url.pathname === "/telegram/webhook") return handleTelegramWebhook(request, env, ctx);
    if (url.pathname === "/bot" || url.pathname.startsWith("/bot/")) return fetchDashboardAsset(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDueReminders(env));
  }
};

function fetchDashboardAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname === "/bot" || url.pathname === "/bot/" ? "/" : url.pathname.replace(/^\/bot/, "");
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const update = (await request.json()) as TelegramUpdate;
  if (update.message?.text) ctx.waitUntil(handleText(update, env, ctx));
  return Response.json({ ok: true });
}

async function handleText(update: TelegramUpdate, env: Env, ctx: ExecutionContext): Promise<void> {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const config = await readConfig(env);
  const memory = memoryStub(env, chatId);
  const receivedAt = new Date().toISOString();
  const existingClient = (await readUsers(env)).find((client) => client.chatId === chatId);

  const baseClient = await upsertClient(env, {
    chatId,
    username: message.chat.username,
    firstName: message.chat.first_name,
    lastName: message.chat.last_name,
    lastMessageAt: receivedAt,
    lastUserText: text,
    messageCount: (existingClient?.messageCount ?? 0) + 1
  });

  await memory.fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "user", text, createdAt: receivedAt })
  });
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, {
    role: "user",
    text,
    createdAt: receivedAt,
    source: "telegram"
  });
  await appendClientMemoryMarkdown(env, chatId, { role: "user", text, createdAt: receivedAt, source: "telegram" });

  const durableContext = (await memory.fetch("https://memory/context").then((response) => response.json())) as ConversationContext;
  const context = await buildClientConversationContext(env, chatId, baseClient, durableContext);

  if (isBotPaused(baseClient)) {
    await appendStoredJsonl(env, "logs/manual_handoff_suppressed.jsonl", {
      chatId,
      text: text.slice(0, 500),
      botPausedUntil: baseClient.botPausedUntil,
      createdAt: receivedAt
    });
    return;
  }

  let answer: string;
  const dayRequest = parseAvailabilityDayRequest(text, env.TIMEZONE || "Europe/Moscow");
  if (/^(\/start|старт)$/i.test(text)) {
    answer =
      "Здравствуйте. Я помогу с записью, ценами и базовой навигацией по консультациям. Можно написать: свободные окна, цены, записаться или связаться с психологом.";
  } else if (/^(цены|прайс)$/i.test(text)) {
    answer = config.prices.map((price) => `${price.serviceId}: ${price.amount} ${price.currency}; ${price.note}`).join("\n");
  } else if (isHumanContactRequest(text)) {
    const botPausedUntil = new Date(Date.now() + CLIENT_HANDOFF_MS).toISOString();
    await upsertClient(env, {
      chatId,
      nextAction: "Клиент просит связаться с психологом.",
      botPausedUntil,
      botPausedBy: "manual",
      botPausedReason: "client_requested_psychologist"
    });
    await appendStoredJsonl(env, "logs/manual_handoff_events.jsonl", {
      chatId,
      action: "client_requested_psychologist",
      botPausedUntil,
      createdAt: new Date().toISOString()
    });
    answer =
      "Я передал запрос психологу. Он увидит сообщение в дашборде и ответит здесь, когда сможет.\n\nЕсли сейчас есть риск причинить вред себе или кому-то рядом, пожалуйста, сразу обратитесь в экстренную службу или к человеку рядом.";
  } else if (/^длительность\s+(\d{2,3})/i.test(text)) {
    const minutes = Number(text.match(/^длительность\s+(\d{2,3})/i)?.[1]);
    const client = await upsertClient(env, { chatId, manualProfile: { modalDurationMinutes: minutes } });
    answer = await availabilityAnswer(env, client, minutes);
  } else if (dayRequest && isAvailabilityRequest(text)) {
    const duration = await suggestedDurationForChat(env, chatId);
    answer = await availabilityAnswerForDay(env, baseClient, duration, dayRequest);
  } else if (isAvailabilityRequest(text)) {
    const duration = await suggestedDurationForChat(env, chatId);
    answer = await availabilityAnswer(env, baseClient, duration);
  } else if (/^бронь\s+/i.test(text)) {
    const rawSlotRef = text.replace(/^бронь\s+/i, "").trim();
    const numericPosition = Number.parseInt(rawSlotRef, 10);
    const held = Number.isFinite(numericPosition) ? await holdFreeSlotByPosition(env, numericPosition, chatId) : await holdSlot(env, rawSlotRef, chatId);
    if (held) {
      await upsertClient(env, {
        chatId,
        agentProfile: {
          sessionHistory: [{ startsAt: held.startsAt, durationMinutes: held.durationMinutes, serviceId: held.durationMinutes <= 30 ? "intro_30" : "consultation" }],
          modalDurationMinutes: held.durationMinutes
        }
      });
      answer = formatHeldBooking(held);
    } else {
      answer = "Окно уже занято или не найдено. Напишите «свободные окна», чтобы получить актуальный список.";
    }
  } else {
    try {
      ctx.waitUntil(sendTelegramChatAction(env, chatId).catch(() => undefined));
      answer = await answerWithOpenAI(env, config, text, context);
    } catch (error) {
      await appendStoredJsonl(env, "logs/ai_errors.jsonl", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      answer = AI_UNAVAILABLE_FALLBACK;
      await upsertClient(env, {
        chatId,
        nextAction: "Агент не ответил клиенту автоматически. Проверить последнее сообщение вручную."
      });
    }
  }

  const answeredAt = new Date().toISOString();
  await memory.fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "assistant", text: answer, createdAt: answeredAt })
  });
  await upsertClient(env, { chatId, lastMessageAt: answeredAt, lastAssistantText: answer });
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, {
    role: "assistant",
    text: answer,
    createdAt: answeredAt,
    source: "bot"
  });
  await appendClientMemoryMarkdown(env, chatId, { role: "assistant", text: answer, createdAt: answeredAt, source: "bot" });
  await sendTelegramMessage(env, chatId, answer);
  const latestClient = (await readUsers(env)).find((client) => client.chatId === chatId) ?? baseClient;
  if (shouldRefreshClientMemoryProfile(latestClient)) {
    ctx.waitUntil(refreshClientMemoryProfile(env, config, chatId, "auto_50_messages").catch((error) => logProfileRefreshError(env, chatId, error)));
  }
}

function isBotPaused(client: ClientSummary): boolean {
  const timestamp = Date.parse(client.botPausedUntil || "");
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function availabilityAnswer(env: Env, client: ClientSummary, durationMinutes: number): Promise<string> {
  const slots = await listFreeSlots(env, 5, durationMinutes, client.chatId);
  const profile = mergedProfile(client);
  const returningClient = profile.sessionHistory.length > 0;
  return formatAvailability(slots, durationMinutes, returningClient);
}

async function availabilityAnswerForDay(env: Env, client: ClientSummary, durationMinutes: number, dayRequest: DayRequest): Promise<string> {
  const slots = await listAvailability(env, dayRequest.fromIso, dayRequest.toIso, durationMinutes, 8);
  const profile = mergedProfile(client);
  const returningClient = profile.sessionHistory.length > 0;
  if (!slots.length) {
    return `На ${dayRequest.label} свободных окон пока нет. Можно написать «свободные окна», и я покажу ближайшие доступные варианты.`;
  }
  return formatAvailability(slots, durationMinutes, returningClient).replace("Ближайшие свободные окна:", `Свободные окна на ${dayRequest.label}:`);
}

function isAvailabilityRequest(text: string): boolean {
  const explicitScheduleWords = /(запис|свободн|слот|окн|брон|расписан|при[её]м|когда.*можно|можно.*(попасть|запис))/i;
  if (explicitScheduleWords.test(text)) return true;
  const dayWords = /(понед|вторн|сред|четвер|пятниц|суббот|воскрес|завтра|послезавтра)/i;
  const dayQuestionWords = /(есть|можно|свободн|окн|слот|запис|при[её]м|время)/i;
  return dayWords.test(text) && dayQuestionWords.test(text);
}

function isHumanContactRequest(text: string): boolean {
  return /^(связаться с психологом|психолог|позвать психолога|нужен психолог|хочу к психологу|задать вопрос)$/i.test(text.trim());
}

function parseAvailabilityDayRequest(text: string, timezone: string): DayRequest | null {
  const normalized = text.toLowerCase();
  const todayKey = localDateKey(new Date(), timezone);
  if (/сегодня/.test(normalized)) return dayRequestFromDateKey(todayKey, "сегодня");
  if (/завтра/.test(normalized) && !/послезавтра/.test(normalized)) return dayRequestFromDateKey(addDays(todayKey, 1), "завтра");
  if (/послезавтра/.test(normalized)) return dayRequestFromDateKey(addDays(todayKey, 2), "послезавтра");

  const weekdays = [
    { index: 1, label: "понедельник", pattern: /понед|пн\b/ },
    { index: 2, label: "вторник", pattern: /вторн|вт\b/ },
    { index: 3, label: "среду", pattern: /сред|ср\b/ },
    { index: 4, label: "четверг", pattern: /четвер|чт\b/ },
    { index: 5, label: "пятницу", pattern: /пятниц|пт\b/ },
    { index: 6, label: "субботу", pattern: /суббот|сб\b/ },
    { index: 0, label: "воскресенье", pattern: /воскрес|вскр|вс\b/ }
  ];
  const match = weekdays.find((weekday) => weekday.pattern.test(normalized));
  return match ? dayRequestFromDateKey(nextWeekdayDateKey(todayKey, match.index), match.label) : null;
}

function dayRequestFromDateKey(dateKey: string, label: string): DayRequest {
  return {
    label,
    fromIso: `${dateKey}T00:00:00+03:00`,
    toIso: `${addDays(dateKey, 1)}T00:00:00+03:00`
  };
}

function nextWeekdayDateKey(todayKey: string, weekdayIndex: number): string {
  const todayIndex = weekdayIndexForDateKey(todayKey);
  const delta = (weekdayIndex - todayIndex + 7) % 7;
  return addDays(todayKey, delta);
}

function weekdayIndexForDateKey(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00+03:00`).getUTCDay();
}

function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(dateKey: string, days: number): string {
  const timestamp = Date.parse(`${dateKey}T12:00:00+03:00`) + days * 24 * 60 * 60 * 1000;
  return localDateKey(new Date(timestamp), "Europe/Moscow");
}

async function logProfileRefreshError(env: Env, chatId: string, error: unknown): Promise<void> {
  await appendStoredJsonl(env, "logs/profile_extract_errors.jsonl", {
    chatId,
    message: error instanceof Error ? error.message : String(error),
    createdAt: new Date().toISOString()
  });
}

function formatHeldBooking(booking: { startsAt: string; endsAt: string }): string {
  const start = new Date(booking.startsAt);
  const end = new Date(booking.endsAt);
  const day = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow"
  }).format(start);
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(start);
  const endTime = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(end);
  return `Готово. Окно временно удержано: ${day}, ${time}-${endTime}. Психолог подтвердит запись.`;
}
