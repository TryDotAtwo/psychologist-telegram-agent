import { handleAdminApi } from "./admin";
import { clientDisplayName, holdFreeSlotByPosition, holdSlot, listFreeSlots, suggestedDurationForChat } from "./calendar";
import { ChatMemory, memoryStub } from "./memory";
import { answerWithOpenAI, extractClientProfilePatch } from "./openai";
import { createReminder, processDueReminders } from "./reminders";
import { appendStoredJsonl, mergedProfile, readConfig, readUsers, upsertClient } from "./storage";
import { formatAvailability, sendTelegramMessage } from "./telegram";
import type { ClientRiskLevel, ClientSummary, Env, TelegramUpdate } from "./types";

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
  if (update.message?.text) ctx.waitUntil(handleText(update, env));
  return Response.json({ ok: true });
}

async function handleText(update: TelegramUpdate, env: Env): Promise<void> {
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

  const context = await memory.fetch("https://memory/context").then((response) => response.json());
  await extractAndStoreClientSignals(env, config, chatId, text, context as { profile: unknown; turns: { role: string; text: string; createdAt: string }[] });

  let answer: string;
  if (/^(\/start|старт)$/i.test(text)) {
    answer =
      "Здравствуйте. Я помогу с записью, ценами и базовой навигацией по консультациям. Можно написать: свободные окна, цены, записаться или задать вопрос.";
  } else if (/^(цены|прайс)$/i.test(text)) {
    answer = config.prices.map((price) => `${price.serviceId}: ${price.amount} ${price.currency}; ${price.note}`).join("\n");
  } else if (/^длительность\s+(\d{2,3})/i.test(text)) {
    const minutes = Number(text.match(/^длительность\s+(\d{2,3})/i)?.[1]);
    const client = await upsertClient(env, { chatId, manualProfile: { modalDurationMinutes: minutes } });
    answer = await availabilityAnswer(env, client, minutes);
  } else if (/^(записаться|свободн|слот|окн)/i.test(text)) {
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
      answer = await answerWithOpenAI(env, config, text, context as { profile: unknown; turns: { role: string; text: string; createdAt: string }[] });
    } catch (error) {
      answer = "AI-ответ сейчас не работает. Можно написать «свободные окна» или «цены», а психолог увидит сообщение в дашборде.";
      await appendStoredJsonl(env, "logs/ai_errors.jsonl", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
    }
  }

  await memory.fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "assistant", text: answer, createdAt: new Date().toISOString() })
  });
  await upsertClient(env, { chatId, lastMessageAt: new Date().toISOString(), lastAssistantText: answer });
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, {
    user: text,
    assistant: answer,
    createdAt: new Date().toISOString()
  });
  await sendTelegramMessage(env, chatId, answer);
}

async function extractAndStoreClientSignals(
  env: Env,
  config: Awaited<ReturnType<typeof readConfig>>,
  chatId: string,
  text: string,
  context: { profile: unknown; turns: { role: string; text: string; createdAt: string }[] }
): Promise<void> {
  try {
    const extraction = await extractClientProfilePatch(env, config, text, context);
    if (!extraction) return;
    await upsertClient(env, {
      chatId,
      tags: extraction.tags,
      agentProfile: extraction.profile,
      riskLevel: mergeRisk(undefined, extraction.riskLevel),
      nextAction: extraction.nextAction
    });
    for (const reminder of extraction.reminders ?? []) {
      await createReminder(env, { chatId, text: reminder.text, dueAt: reminder.dueAt, timezone: reminder.timezone, source: "agent" });
    }
  } catch (error) {
    await appendStoredJsonl(env, "logs/profile_extract_errors.jsonl", {
      chatId,
      text: text.slice(0, 500),
      message: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString()
    });
  }
}

async function availabilityAnswer(env: Env, client: ClientSummary, durationMinutes: number): Promise<string> {
  const slots = await listFreeSlots(env, 5, durationMinutes, client.chatId);
  const profile = mergedProfile(client);
  const returningClient = client.messageCount > 1 || profile.sessionHistory.length > 0;
  return formatAvailability(slots, durationMinutes, returningClient);
}

function mergeRisk(current: ClientRiskLevel | undefined, next: ClientRiskLevel | undefined): ClientRiskLevel {
  if (current === "urgent" || next === "urgent") return "urgent";
  if (current === "watch" || next === "watch") return "watch";
  return "none";
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
