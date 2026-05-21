import { handleAdminApi } from "./admin";
import { holdFreeSlotByPosition, holdSlot, listFreeSlots } from "./calendar";
import { ChatMemory, memoryStub } from "./memory";
import { answerWithOpenAI } from "./openai";
import { appendStoredJsonl, readConfig, readUsers, upsertClient } from "./storage";
import { formatSlots, sendTelegramMessage } from "./telegram";
import type { Env, TelegramUpdate } from "./types";

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
  const clientSignals = analyzeClientMessage(text);
  await upsertClient(env, {
    chatId,
    username: message.chat.username,
    firstName: message.chat.first_name,
    lastName: message.chat.last_name,
    lastMessageAt: receivedAt,
    lastUserText: text,
    messageCount: (existingClient?.messageCount ?? 0) + 1,
    tags: clientSignals.tags,
    facts: clientSignals.facts,
    reminders: clientSignals.reminders,
    riskLevel: mergeRisk(existingClient?.riskLevel, clientSignals.riskLevel),
    nextAction: clientSignals.nextAction ?? existingClient?.nextAction
  });
  await memory.fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "user", text, createdAt: receivedAt })
  });

  let answer: string;
  if (/^(\/start|старт)$/i.test(text)) {
    answer = "Здравствуйте. Бот помогает с записью и первичной навигацией. Можно спросить про формат, цену, свободные окна или записаться.";
  } else if (/^(цены|прайс)$/i.test(text)) {
    answer = config.prices.map((price) => `${price.serviceId}: ${price.amount} ${price.currency}; ${price.note}`).join("\n");
  } else if (/^(записаться|свободн|слот|окн)/i.test(text)) {
    answer = formatSlots(await listFreeSlots(env));
  } else if (/^бронь\s+/i.test(text)) {
    const rawSlotRef = text.replace(/^бронь\s+/i, "").trim();
    const numericPosition = Number.parseInt(rawSlotRef, 10);
    const held = Number.isFinite(numericPosition)
      ? await holdFreeSlotByPosition(env, numericPosition, chatId)
      : await holdSlot(env, rawSlotRef, chatId);
    answer = held ? formatHeldSlot(held) : "Окно не найдено или уже занято. Напишите: свободные слоты.";
  } else {
    const context = await memory.fetch("https://memory/context").then((response) => response.json());
    try {
      answer = await answerWithOpenAI(env, config, text, context as { profile: unknown; turns: { role: string; text: string; createdAt: string }[] });
    } catch (error) {
      answer = `AI-ответ сейчас не работает. Ошибка зафиксирована. Можно написать "свободные слоты" или "цены".`;
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
  await upsertClient(env, {
    chatId,
    lastMessageAt: new Date().toISOString(),
    lastAssistantText: answer,
    riskLevel: mergeRisk(existingClient?.riskLevel, clientSignals.riskLevel)
  });
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, {
    user: text,
    assistant: answer,
    createdAt: new Date().toISOString()
  });
  await sendTelegramMessage(env, chatId, answer);
}

function analyzeClientMessage(text: string): {
  tags: string[];
  facts: string[];
  reminders: string[];
  riskLevel: "none" | "watch" | "urgent";
  nextAction?: string;
} {
  const normalized = text.toLowerCase();
  const tags: string[] = [];
  const facts: string[] = [];
  const reminders: string[] = [];
  let riskLevel: "none" | "watch" | "urgent" = "none";
  let nextAction: string | undefined;

  if (/запис|слот|окн|консультац|встреч/.test(normalized)) {
    tags.push("запись");
    nextAction = "Проверить потребность в записи и подтвердить время.";
  }
  if (/цен|стоим|оплат|чек|ссылк/.test(normalized)) {
    tags.push("оплата");
    nextAction = "Проверить оплату, ссылку и чек после записи.";
  }
  if (/таблет|лекарств|медикамент|психиатр|врач|прием/.test(normalized)) {
    tags.push("медицина");
    reminders.push("Уточнить безопасный формат напоминаний: препарат/время/согласие клиента.");
  }
  if (/рас|аутиз|сдвг|нейро/.test(normalized)) tags.push("нейроотличность");
  if (/тревог|паник|выгор|депресс|сон|сенсор/.test(normalized)) tags.push("самочувствие");
  if (/самоуб|суицид|умереть|убить себя|навредить себе|не хочу жить/.test(normalized)) {
    riskLevel = "urgent";
    tags.push("кризис");
    nextAction = "Срочно вручную проверить диалог и при необходимости дать кризисные контакты.";
  } else if (/плохо|срыв|кризис|истерик|опасн/.test(normalized)) {
    riskLevel = "watch";
    tags.push("наблюдение");
  }
  const rememberMatch = normalized.match(/(?:запомни|важно|факт)[:\s]+(.{8,180})/);
  if (rememberMatch?.[1]) facts.push(rememberMatch[1].trim());
  const nameMatch = text.match(/меня зовут\s+([A-Za-zА-Яа-яЁё -]{2,40})/i);
  if (nameMatch?.[1]) facts.push(`Имя: ${nameMatch[1].trim()}`);
  return { tags, facts, reminders, riskLevel, nextAction };
}

function mergeRisk(current: "none" | "watch" | "urgent" | undefined, next: "none" | "watch" | "urgent"): "none" | "watch" | "urgent" {
  if (current === "urgent" || next === "urgent") return "urgent";
  if (current === "watch" || next === "watch") return "watch";
  return "none";
}

function formatHeldSlot(slot: { startsAt: string; endsAt: string }): string {
  const start = new Date(slot.startsAt);
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
  return `Готово. Окно временно удержано: ${day}, ${time}. Администратор подтвердит запись.`;
}
