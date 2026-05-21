import { getGoogleAccessToken, googleOAuthConfigured, readGoogleTokens } from "./google";
import { readSlots, writeSlots } from "./storage";
import type { CalendarSlot, Env } from "./types";

export async function listFreeSlots(env: Env, limit = 3): Promise<CalendarSlot[]> {
  const slots = await readSlots(env);
  return slots
    .filter((slot) => slot.status === "free" && Date.parse(slot.startsAt) > Date.now())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit);
}

export async function holdSlot(env: Env, slotId: string, chatId: string): Promise<CalendarSlot | null> {
  const slots = await readSlots(env);
  const index = slots.findIndex((slot) => slot.id === slotId && slot.status === "free");
  if (index < 0) return null;
  const held = { ...slots[index], status: "held" as const, clientChatId: chatId };
  slots[index] = held;
  await writeSlots(env, slots);
  await createGoogleCalendarHold(env, held, chatId);
  return held;
}

export async function holdFreeSlotByPosition(env: Env, position: number, chatId: string): Promise<CalendarSlot | null> {
  const freeSlots = await listFreeSlots(env, Math.max(position, 3));
  const slot = freeSlots[position - 1];
  if (!slot) return null;
  return holdSlot(env, slot.id, chatId);
}

export async function calendarConnectionStatus(env: Env): Promise<{ configured: boolean; connected: boolean; email?: string; missing: string[] }> {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.GOOGLE_ADMIN_EMAIL) missing.push("GOOGLE_ADMIN_EMAIL");
  const tokens = await readGoogleTokens(env);
  return {
    configured: googleOAuthConfigured(env),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    email: tokens?.email,
    missing
  };
}

export async function syncGoogleCalendarCache(env: Env): Promise<{ ok: boolean; reason?: string; slotsWritten?: number }> {
  if (!googleOAuthConfigured(env)) return { ok: false, reason: "google_oauth_secrets_missing" };
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return { ok: false, reason: "google_not_connected" };
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250"
  });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return { ok: false, reason: `google_events_status_${response.status}` };
  const data = (await response.json()) as { items?: { start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[] };
  const busy = (data.items ?? [])
    .map((event) => ({ start: event.start?.dateTime ?? event.start?.date, end: event.end?.dateTime ?? event.end?.date }))
    .filter((event): event is { start: string; end: string } => Boolean(event.start && event.end));
  const generated = generateSlots(timeMin, timeMax, busy);
  const current = await readSlots(env);
  const manualHeldOrBooked = current.filter((slot) => slot.source === "manual" || slot.status !== "free");
  await writeSlots(env, [...manualHeldOrBooked, ...generated]);
  return { ok: true, slotsWritten: generated.length };
}

function generateSlots(timeMin: Date, timeMax: Date, busy: { start: string; end: string }[]): CalendarSlot[] {
  const result: CalendarSlot[] = [];
  const busyRanges = busy.map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }));
  for (let cursor = startOfNextHour(timeMin); cursor < timeMax && result.length < 30; cursor = new Date(cursor.getTime() + 60 * 60 * 1000)) {
    const day = cursor.getDay();
    const hour = cursor.getHours();
    if (day === 0 || day === 6 || hour < 10 || hour >= 19) continue;
    const end = new Date(cursor.getTime() + 60 * 60 * 1000);
    const overlaps = busyRanges.some((range) => cursor.getTime() < range.end && end.getTime() > range.start);
    if (!overlaps) {
      result.push({
        id: `gcal_${cursor.toISOString().replace(/[-:.]/g, "")}`,
        startsAt: cursor.toISOString(),
        endsAt: end.toISOString(),
        status: "free",
        source: "google_calendar_cache"
      });
    }
  }
  return result;
}

function startOfNextHour(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  if (next <= date) next.setHours(next.getHours() + 1);
  return next;
}

async function createGoogleCalendarHold(env: Env, slot: CalendarSlot, chatId: string): Promise<void> {
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return;
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: "Предварительная запись из Telegram-бота",
      description: `Telegram chat_id=${chatId}; slot_id=${slot.id}; статус=held`,
      start: { dateTime: slot.startsAt, timeZone: env.TIMEZONE || "Europe/Moscow" },
      end: { dateTime: slot.endsAt, timeZone: env.TIMEZONE || "Europe/Moscow" }
    })
  });
}
