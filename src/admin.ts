import { calendarConnectionStatus, createBooking, listAvailability, syncGoogleCalendarCache, visibleBusyRanges } from "./calendar";
import { refreshClientMemoryProfile } from "./client_memory";
import { createGoogleAuthUrl, googleOAuthConfigured, handleGoogleCallback } from "./google";
import { answerWithOpenAI, openRouterModelCandidates } from "./openai";
import {
  listScheduledOutboundMessages,
  recordAdminOutbound,
  scheduleOutboundMessage,
  storeOutboundAttachment
} from "./outbound_messages";
import { cancelReminder, createReminder, sendReminderNow, updateReminder } from "./reminders";
import {
  appendStoredJsonl,
  mergedProfile,
  normalizeProfile,
  readBookings,
  readConfig,
  readReminders,
  readSchedule,
  readTranscript,
  readUsers,
  upsertClient,
  writeConfig,
  writeSchedule
} from "./storage";
import { escapeTelegramHtml, getTelegramWebhookInfo, sendTelegramMedia, sendTelegramMessage, setTelegramWebhook } from "./telegram";
import type { BotConfig, ClientSummary, Env, OutboundAttachment, ScheduledOutboundMessage, TranscriptMessage, WorkSchedule } from "./types";

const SESSION_COOKIE = "admin_session";

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/login") return login(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return logout();
  if (request.method === "GET" && url.pathname === "/api/session") return Response.json({ authenticated: authorized(request, env) });
  if (request.method === "GET" && url.pathname === "/api/auth/google") return startGoogleLogin(request, env);
  if (request.method === "GET" && url.pathname === "/api/auth/google/callback") return finishGoogleLogin(request, env);
  if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (request.method === "GET" && url.pathname === "/api/config") return Response.json(await readConfig(env));
  if (request.method === "GET" && url.pathname === "/api/ai/status") return Response.json(await aiStatus(env));
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const config = (await request.json()) as BotConfig;
    await writeConfig(env, config);
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/users") {
    const users = await readUsers(env);
    return Response.json(users.map((user) => ({ ...user, mergedProfile: mergedProfile(user) })));
  }
  if (request.method === "GET" && url.pathname === "/api/outbound-messages") {
    const messages = await listScheduledOutboundMessages(env, url.searchParams.get("chatId") ?? undefined);
    return Response.json(messages.map((message) => ({
      ...message,
      attachments: message.attachments.map(({ key: _key, ...attachment }) => attachment)
    })));
  }
  const userRoute = parseUserRoute(url.pathname);
  if (userRoute && request.method === "GET" && userRoute.action === "messages") return Response.json(await transcriptPage(env, userRoute.chatId, url));
  if (userRoute && request.method === "PUT" && userRoute.action === "profile") return Response.json(await updateUserProfile(request, env, userRoute.chatId));
  if (userRoute && request.method === "POST" && userRoute.action === "reply") return sendAdminReply(request, env, userRoute.chatId);
  if (userRoute && request.method === "POST" && userRoute.action === "reply-media") return sendAdminMediaReply(request, env, userRoute.chatId);
  if (userRoute && request.method === "POST" && userRoute.action === "bot-resume") return resumeBotForClient(env, userRoute.chatId);
  if (userRoute && request.method === "POST" && userRoute.action === "profile-refresh") return refreshProfileFromDashboard(env, userRoute.chatId);

  if (request.method === "GET" && url.pathname === "/api/calendar/schedule") return Response.json(await readSchedule(env));
  if (request.method === "PUT" && url.pathname === "/api/calendar/schedule") {
    const schedule = normalizeSchedule((await request.json()) as WorkSchedule, env);
    await writeSchedule(env, schedule);
    return Response.json(schedule);
  }
  if (request.method === "GET" && url.pathname === "/api/calendar/availability") {
    const from = url.searchParams.get("from") ?? new Date().toISOString();
    const to = url.searchParams.get("to") ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const durationMinutes = Number(url.searchParams.get("durationMinutes") ?? "30");
    const [availability, busy] = await Promise.all([listAvailability(env, from, to, durationMinutes, 240), visibleBusyRanges(env, from, to)]);
    return Response.json({ availability, busy });
  }
  if (request.method === "GET" && url.pathname === "/api/calendar/bookings") return Response.json(await readBookings(env));
  if (request.method === "POST" && url.pathname === "/api/calendar/bookings") {
    const body = (await request.json()) as { availabilityId?: string; chatId?: string; clientName?: string; durationMinutes?: number };
    if (!body.availabilityId || !body.durationMinutes) return Response.json({ error: "missing_booking_fields" }, { status: 400 });
    const booking = await createBooking(env, {
      availabilityId: body.availabilityId,
      chatId: body.chatId,
      clientName: body.clientName,
      durationMinutes: body.durationMinutes,
      source: "admin",
      status: "booked"
    });
    if (!booking) return Response.json({ error: "availability_not_found_or_busy" }, { status: 409 });
    return Response.json(booking);
  }
  if (request.method === "POST" && url.pathname === "/api/calendar/sync") return Response.json(await syncGoogleCalendarCache(env));
  if (request.method === "GET" && url.pathname === "/api/calendar/status") return Response.json(await calendarConnectionStatus(env));
  if (request.method === "GET" && url.pathname === "/api/telegram/webhook/status") return Response.json(await telegramWebhookStatus(env));
  if ((request.method === "POST" || request.method === "GET") && url.pathname === "/api/telegram/webhook/sync") {
    return Response.json(await syncTelegramWebhook(request, env));
  }

  if (request.method === "GET" && url.pathname === "/api/reminders") {
    const chatId = url.searchParams.get("chatId");
    const reminders = await readReminders(env);
    return Response.json(chatId ? reminders.filter((reminder) => reminder.chatId === chatId) : reminders);
  }
  if (request.method === "POST" && url.pathname === "/api/reminders") {
    const body = (await request.json()) as { chatId?: string; text?: string; dueAt?: string; timezone?: string; repeat?: "none" | "daily" | "weekly" | "monthly" };
    if (!body.chatId || !body.text || !body.dueAt) return Response.json({ error: "missing_reminder_fields" }, { status: 400 });
    const reminder = await createReminder(env, { chatId: body.chatId, text: body.text, dueAt: body.dueAt, timezone: body.timezone, repeat: body.repeat, source: "admin" });
    if (!reminder) return Response.json({ error: "invalid_reminder" }, { status: 400 });
    return Response.json(reminder);
  }
  const reminderRoute = parseReminderRoute(url.pathname);
  if (reminderRoute && request.method === "PUT") return Response.json(await updateReminder(env, reminderRoute.id, await request.json()) ?? { error: "not_found" });
  if (reminderRoute && request.method === "POST" && reminderRoute.action === "cancel") return Response.json(await cancelReminder(env, reminderRoute.id) ?? { error: "not_found" });
  if (reminderRoute && request.method === "POST" && reminderRoute.action === "send-now") return Response.json(await sendReminderNow(env, reminderRoute.id) ?? { error: "not_found" });

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function aiStatus(env: Env): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  try {
    const config = await readConfig(env);
    const answer = await answerWithOpenAI(env, config, "Проверка связи. Ответь одной короткой фразой: бот готов.", { profile: {}, turns: [] });
    return {
      ok: true,
      provider: env.OPENAI_API_KEY ? "openai" : env.OPENROUTER_API_KEY ? "openrouter" : "none",
      model: env.OPENAI_API_KEY ? env.OPENAI_MODEL : env.OPENROUTER_MODEL,
      fallbackModels: env.OPENROUTER_API_KEY ? openRouterModelCandidates(env) : [],
      latencyMs: Date.now() - startedAt,
      sample: answer.slice(0, 160)
    };
  } catch (error) {
    return {
      ok: false,
      provider: env.OPENAI_API_KEY ? "openai" : env.OPENROUTER_API_KEY ? "openrouter" : "none",
      model: env.OPENAI_API_KEY ? env.OPENAI_MODEL : env.OPENROUTER_MODEL,
      fallbackModels: env.OPENROUTER_API_KEY ? openRouterModelCandidates(env) : [],
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
    };
  }
}

async function telegramWebhookStatus(env: Env): Promise<Record<string, unknown>> {
  const info = await getTelegramWebhookInfo(env);
  return {
    ok: info.ok,
    result: info.result,
    description: info.description,
    error_code: info.error_code
  };
}

async function syncTelegramWebhook(request: Request, env: Env): Promise<Record<string, unknown>> {
  const requestUrl = new URL(request.url);
  const body =
    request.method === "GET" ? { url: requestUrl.searchParams.get("url") ?? undefined } : ((await request.json().catch(() => ({}))) as { url?: string });
  const fallbackUrl = `${new URL(request.url).origin}/telegram/webhook`;
  const webhookUrl = typeof body.url === "string" && body.url.startsWith("https://") ? body.url : fallbackUrl;
  const setResult = await setTelegramWebhook(env, webhookUrl);
  const status = await getTelegramWebhookInfo(env);
  return {
    ok: setResult.ok && status.ok,
    webhookUrl,
    setResult,
    status
  };
}

function parseUserRoute(pathname: string): { chatId: string; action: "profile" | "messages" | "reply" | "reply-media" | "bot-resume" | "profile-refresh" } | null {
  const match = pathname.match(/^\/api\/users\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  const suffix = match[2] ?? "";
  const action =
    suffix === "messages" || suffix === "reply"
      ? suffix
      : suffix === "reply/media"
        ? "reply-media"
      : suffix === "bot/resume"
        ? "bot-resume"
        : suffix === "profile/refresh"
          ? "profile-refresh"
          : suffix
            ? null
            : "profile";
  if (!action) return null;
  return { chatId: decodeURIComponent(match[1]), action };
}

function parseReminderRoute(pathname: string): { id: string; action?: "cancel" | "send-now" } | null {
  const match = pathname.match(/^\/api\/reminders\/([^/]+)(?:\/(cancel|send-now))?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), action: match[2] as "cancel" | "send-now" | undefined };
}

function isFutureIso(value: string | undefined): value is string {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() + 15_000;
}

function stringFormValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function isSupportedMediaFile(file: File): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("video/");
}

function publicOutboundMessage(message: ScheduledOutboundMessage): Omit<ScheduledOutboundMessage, "attachments"> & { attachments: Omit<OutboundAttachment, "key">[] } {
  return {
    ...message,
    attachments: message.attachments.map(({ key: _key, ...attachment }) => attachment)
  };
}

async function updateUserProfile(request: Request, env: Env, chatId: string): Promise<ClientSummary> {
  const body = (await request.json()) as Partial<ClientSummary>;
  const next = await upsertClient(env, {
    chatId,
    username: body.username,
    firstName: body.firstName,
    lastName: body.lastName,
    tags: normalizeList(body.tags),
    riskLevel: body.riskLevel,
    nextAction: body.nextAction,
    manualProfile: normalizeProfile(body.manualProfile)
  });
  await appendStoredJsonl(env, "logs/manual_profile_edits.jsonl", { chatId, editedAt: new Date().toISOString() });
  return { ...next, facts: mergedProfile(next).facts, reminders: mergedProfile(next).reminders };
}

async function sendAdminReply(request: Request, env: Env, chatId: string): Promise<Response> {
  const body = (await request.json()) as { text?: string; scheduledAt?: string };
  const text = body.text?.trim();
  if (!text) return Response.json({ error: "empty_text" }, { status: 400 });
  if (text.length > 3500) return Response.json({ error: "text_too_long" }, { status: 400 });
  if (isFutureIso(body.scheduledAt)) {
    const message = await scheduleOutboundMessage(env, { chatId, text, dueAt: body.scheduledAt as string });
    if (!message) return Response.json({ error: "invalid_scheduled_message" }, { status: 400 });
    return Response.json({ ok: true, scheduled: true, createdAt: message.createdAt, scheduledAt: message.dueAt, message: publicOutboundMessage(message) });
  }
  try {
    await sendTelegramMessage(env, chatId, escapeTelegramHtml(text));
  } catch (error) {
    return Response.json(
      { error: "telegram_send_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
  const createdAt = new Date().toISOString();
  const next = await recordAdminOutbound(env, chatId, text, createdAt);
  return Response.json({ ok: true, createdAt, botPausedUntil: next.botPausedUntil, client: { ...next, mergedProfile: mergedProfile(next) } });
}

async function sendAdminMediaReply(request: Request, env: Env, chatId: string): Promise<Response> {
  const formData = await request.formData();
  const caption = stringFormValue(formData.get("caption")).trim().slice(0, 1024);
  const scheduledAt = stringFormValue(formData.get("scheduledAt"));
  const files = formData.getAll("files").filter((item): item is File => item instanceof File && isSupportedMediaFile(item));
  if (!files.length) return Response.json({ error: "missing_media" }, { status: 400 });
  if (isFutureIso(scheduledAt)) {
    const pendingId = `pending_${crypto.randomUUID()}`;
    const attachments: OutboundAttachment[] = [];
    for (const file of files.slice(0, 10)) attachments.push(await storeOutboundAttachment(env, pendingId, file));
    const message = await scheduleOutboundMessage(env, { chatId, text: caption, dueAt: scheduledAt, attachments });
    if (!message) return Response.json({ error: "invalid_scheduled_media" }, { status: 400 });
    return Response.json({ ok: true, scheduled: true, createdAt: message.createdAt, scheduledAt: message.dueAt, message: publicOutboundMessage(message) });
  }
  const attachments: OutboundAttachment[] = files.slice(0, 10).map((file) => ({
    filename: file.name || "media",
    mimeType: file.type || "application/octet-stream",
    size: file.size
  }));
  try {
    for (let index = 0; index < files.slice(0, 10).length; index += 1) {
      const file = files[index];
      await sendTelegramMedia(env, chatId, {
        blob: file,
        filename: file.name || "media",
        mimeType: file.type || "application/octet-stream",
        caption: index === 0 ? caption : ""
      });
    }
  } catch (error) {
    return Response.json(
      { error: "telegram_media_send_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
  const createdAt = new Date().toISOString();
  const next = await recordAdminOutbound(env, chatId, caption, createdAt, attachments);
  return Response.json({ ok: true, createdAt, client: { ...next, mergedProfile: mergedProfile(next) }, attachments });
}

async function resumeBotForClient(env: Env, chatId: string): Promise<Response> {
  const createdAt = new Date().toISOString();
  const next = await upsertClient(env, {
    chatId,
    attentionAt: undefined,
    attentionReason: undefined,
    botPausedUntil: undefined,
    botPausedReason: undefined,
    botPausedBy: undefined
  });
  await appendStoredJsonl(env, "logs/manual_handoff_events.jsonl", {
    chatId,
    action: "resume",
    createdAt
  });
  return Response.json({ ok: true, createdAt, client: { ...next, mergedProfile: mergedProfile(next) } });
}

async function refreshProfileFromDashboard(env: Env, chatId: string): Promise<Response> {
  const config = await readConfig(env);
  const client = await refreshClientMemoryProfile(env, config, chatId, "manual_dashboard");
  if (!client) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true, client: { ...client, mergedProfile: mergedProfile(client) } });
}

function normalizeSchedule(schedule: WorkSchedule, env: Env): WorkSchedule {
  return {
    timezone: schedule.timezone || env.TIMEZONE || "Europe/Moscow",
    slotStepMinutes: clampNumber(schedule.slotStepMinutes, 5, 120, 30),
    introDurationMinutes: clampNumber(schedule.introDurationMinutes, 15, 180, 30),
    defaultSessionMinutes: clampNumber(schedule.defaultSessionMinutes, 15, 240, 60),
    weeklyTemplate: schedule.weeklyTemplate,
    dateOverrides: schedule.dateOverrides ?? {}
  };
}

async function transcriptPage(env: Env, chatId: string, url: URL): Promise<{ messages: TranscriptMessage[]; hasMore: boolean; before?: string }> {
  const limit = clampNumber(Number(url.searchParams.get("limit") ?? "100"), 1, 100, 100);
  const before = url.searchParams.get("before");
  const sorted = (await readTranscript(env, chatId)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const eligible = before ? sorted.filter((message) => Date.parse(message.createdAt) < Date.parse(before)) : sorted;
  const messages = eligible.slice(-limit);
  return { messages, hasMore: eligible.length > messages.length, before: messages[0]?.createdAt };
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Number(value), min), max) : fallback;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 60);
}

async function login(request: Request, env: Env): Promise<Response> {
  await request.arrayBuffer();
  void env;
  return Response.json({ error: "password_login_disabled" }, { status: 410 });
}

function logout(): Response {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      }
    }
  );
}

async function startGoogleLogin(request: Request, env: Env): Promise<Response> {
  const prefix = request.headers.get("X-Dashboard-Prefix") ?? "";
  if (!googleOAuthConfigured(env)) {
    return Response.redirect(`${new URL(request.url).origin}${prefix}/?google=not_configured`, 302);
  }
  return Response.redirect(await createGoogleAuthUrl(request, env), 302);
}

async function finishGoogleLogin(request: Request, env: Env): Promise<Response> {
  const result = await handleGoogleCallback(request, env);
  const origin = new URL(request.url).origin;
  const prefix = request.headers.get("X-Dashboard-Prefix") ?? "";
  if (!result.ok) return Response.redirect(`${origin}${prefix}/?google=${encodeURIComponent(result.error ?? "failed")}`, 302);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}${prefix}/?google=connected`,
      "Set-Cookie": `${SESSION_COOKIE}=${env.ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
    }
  });
}

function authorized(request: Request, env: Env): boolean {
  const bearer = request.headers.get("Authorization") ?? "";
  if (bearer === `Bearer ${env.ADMIN_TOKEN}`) return true;
  return readCookie(request, SESSION_COOKIE) === env.ADMIN_TOKEN;
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const parts = cookie.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
