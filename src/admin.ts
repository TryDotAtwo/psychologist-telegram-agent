import { calendarConnectionStatus, createBooking, listAvailability, syncGoogleCalendarCache, visibleBusyRanges } from "./calendar";
import { createGoogleAuthUrl, handleGoogleCallback } from "./google";
import { memoryStub } from "./memory";
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
import { escapeTelegramHtml, getTelegramWebhookInfo, sendTelegramMessage, setTelegramWebhook } from "./telegram";
import type { BotConfig, ClientSummary, Env, WorkSchedule } from "./types";

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
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const config = (await request.json()) as BotConfig;
    await writeConfig(env, config);
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/users") {
    const users = await readUsers(env);
    return Response.json(users.map((user) => ({ ...user, mergedProfile: mergedProfile(user) })));
  }
  const userRoute = parseUserRoute(url.pathname);
  if (userRoute && request.method === "GET" && userRoute.action === "messages") return Response.json(await readTranscript(env, userRoute.chatId));
  if (userRoute && request.method === "PUT" && userRoute.action === "profile") return Response.json(await updateUserProfile(request, env, userRoute.chatId));
  if (userRoute && request.method === "POST" && userRoute.action === "reply") return sendAdminReply(request, env, userRoute.chatId);

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
  if (request.method === "POST" && url.pathname === "/api/telegram/webhook/sync") return Response.json(await syncTelegramWebhook(request, env));

  if (request.method === "GET" && url.pathname === "/api/reminders") {
    const chatId = url.searchParams.get("chatId");
    const reminders = await readReminders(env);
    return Response.json(chatId ? reminders.filter((reminder) => reminder.chatId === chatId) : reminders);
  }
  if (request.method === "POST" && url.pathname === "/api/reminders") {
    const body = (await request.json()) as { chatId?: string; text?: string; dueAt?: string; timezone?: string };
    if (!body.chatId || !body.text || !body.dueAt) return Response.json({ error: "missing_reminder_fields" }, { status: 400 });
    const reminder = await createReminder(env, { chatId: body.chatId, text: body.text, dueAt: body.dueAt, timezone: body.timezone, source: "admin" });
    if (!reminder) return Response.json({ error: "invalid_reminder" }, { status: 400 });
    return Response.json(reminder);
  }
  const reminderRoute = parseReminderRoute(url.pathname);
  if (reminderRoute && request.method === "PUT") return Response.json(await updateReminder(env, reminderRoute.id, await request.json()) ?? { error: "not_found" });
  if (reminderRoute && request.method === "POST" && reminderRoute.action === "cancel") return Response.json(await cancelReminder(env, reminderRoute.id) ?? { error: "not_found" });
  if (reminderRoute && request.method === "POST" && reminderRoute.action === "send-now") return Response.json(await sendReminderNow(env, reminderRoute.id) ?? { error: "not_found" });

  return Response.json({ error: "not_found" }, { status: 404 });
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
  const body = (await request.json().catch(() => ({}))) as { url?: string };
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

function parseUserRoute(pathname: string): { chatId: string; action: "profile" | "messages" | "reply" } | null {
  const match = pathname.match(/^\/api\/users\/([^/]+)(?:\/(messages|reply))?$/);
  if (!match) return null;
  const action = match[2] === "messages" || match[2] === "reply" ? match[2] : "profile";
  return { chatId: decodeURIComponent(match[1]), action };
}

function parseReminderRoute(pathname: string): { id: string; action?: "cancel" | "send-now" } | null {
  const match = pathname.match(/^\/api\/reminders\/([^/]+)(?:\/(cancel|send-now))?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), action: match[2] as "cancel" | "send-now" | undefined };
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
  const body = (await request.json()) as { text?: string };
  const text = body.text?.trim();
  if (!text) return Response.json({ error: "empty_text" }, { status: 400 });
  if (text.length > 3500) return Response.json({ error: "text_too_long" }, { status: 400 });
  try {
    await sendTelegramMessage(env, chatId, escapeTelegramHtml(text));
  } catch (error) {
    return Response.json(
      { error: "telegram_send_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
  const createdAt = new Date().toISOString();
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, { role: "assistant", text, createdAt, source: "admin" });
  await memoryStub(env, chatId).fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "assistant", text, createdAt })
  });
  await upsertClient(env, { chatId, lastAssistantText: text, lastMessageAt: createdAt });
  return Response.json({ ok: true, createdAt });
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

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Number(value), min), max) : fallback;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 60);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { password?: string };
  const expectedPassword = env.ADMIN_PASSWORD || env.ADMIN_TOKEN;
  if (!body.password || body.password !== expectedPassword) return Response.json({ error: "invalid_password" }, { status: 401 });
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `${SESSION_COOKIE}=${env.ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
      }
    }
  );
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
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_ADMIN_EMAIL) {
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
