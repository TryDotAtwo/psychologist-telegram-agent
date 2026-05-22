import { allowedGoogleEmails, getGoogleAccessToken, googleOAuthConfigured, readGoogleTokens } from "./google";
import { buildAvailability } from "./calendar_core";
import type { BusyRange } from "./calendar_core";
import { appStateStub } from "./memory";
import {
  appendStoredJsonl,
  readBookings,
  readGoogleBusy,
  readSchedule,
  readUsers,
  writeBookings,
  writeGoogleBusy
} from "./storage";
import type { AvailabilityWindow, Booking, ClientSummary, Env, GoogleBusyEvent } from "./types";

export async function listFreeSlots(env: Env, limit = 3, durationMinutes?: number, chatId?: string): Promise<AvailabilityWindow[]> {
  const duration = durationMinutes ?? (chatId ? await suggestedDurationForChat(env, chatId) : 30);
  const from = new Date();
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return listAvailability(env, from.toISOString(), to.toISOString(), duration, limit);
}

export async function listAvailability(
  env: Env,
  fromIso: string,
  toIso: string,
  durationMinutes: number,
  limit = 80
): Promise<AvailabilityWindow[]> {
  const [schedule, bookings, googleBusy] = await Promise.all([readSchedule(env), readBookings(env), readGoogleBusy(env)]);
  return buildAvailability(schedule, fromIso, toIso, durationMinutes, [
    ...bookings
      .filter((booking) => booking.status !== "cancelled")
      .map((booking) => ({ startsAt: booking.startsAt, endsAt: booking.endsAt, source: "booking" as const, title: booking.clientName })),
    ...googleBusy.map((busy) => ({ startsAt: busy.startsAt, endsAt: busy.endsAt, source: "google" as const, title: busy.title }))
  ]).slice(0, limit);
}

export async function holdFreeSlotByPosition(env: Env, position: number, chatId: string): Promise<Booking | null> {
  const durationMinutes = await suggestedDurationForChat(env, chatId);
  const freeSlots = await listFreeSlots(env, Math.max(position, 6), durationMinutes, chatId);
  const slot = freeSlots[position - 1];
  if (!slot) return null;
  return createBooking(env, { availabilityId: slot.id, chatId, durationMinutes, source: "bot", status: "held" });
}

export async function holdSlot(env: Env, slotId: string, chatId: string): Promise<Booking | null> {
  const durationMinutes = await suggestedDurationForChat(env, chatId);
  return createBooking(env, { availabilityId: slotId, chatId, durationMinutes, source: "bot", status: "held" });
}

export async function createBooking(
  env: Env,
  input: {
    availabilityId: string;
    chatId?: string;
    clientName?: string;
    durationMinutes: number;
    source: "bot" | "admin";
    status?: "held" | "booked";
  }
): Promise<Booking | null> {
  const lock = await acquireBookingLock(env);
  if (!lock.ok) {
    await appendStoredJsonl(env, "logs/booking_conflicts.jsonl", { input, reason: "lock_busy", createdAt: new Date().toISOString() });
    return null;
  }
  try {
    const from = new Date();
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const availability = await listAvailability(env, from.toISOString(), to.toISOString(), input.durationMinutes, 200);
    const window = availability.find((item) => item.id === input.availabilityId);
    if (!window) {
      await appendStoredJsonl(env, "logs/booking_conflicts.jsonl", { input, reason: "availability_missing", createdAt: new Date().toISOString() });
      return null;
    }
    const now = new Date().toISOString();
    const booking: Booking = {
      id: `booking_${crypto.randomUUID()}`,
      chatId: input.chatId,
      clientName: input.clientName,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      durationMinutes: input.durationMinutes,
      status: input.status ?? "held",
      source: input.source,
      createdAt: now,
      updatedAt: now
    };
    booking.googleEventId = await createGoogleCalendarHold(env, booking);
    const bookings = await readBookings(env);
    bookings.push(booking);
    await writeBookings(env, bookings);
    return booking;
  } finally {
    await releaseBookingLock(env, lock.lockId);
  }
}

export async function calendarConnectionStatus(env: Env): Promise<{ configured: boolean; connected: boolean; email?: string; missing: string[] }> {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!allowedGoogleEmails(env).length) missing.push("GOOGLE_ADMIN_EMAIL or GOOGLE_ADMIN_EMAILS");
  const tokens = await readGoogleTokens(env);
  return {
    configured: googleOAuthConfigured(env),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    email: tokens?.email,
    missing
  };
}

export async function syncGoogleCalendarCache(env: Env): Promise<{ ok: boolean; reason?: string; busyWritten?: number; availabilityWritten?: number }> {
  if (!googleOAuthConfigured(env)) return { ok: false, reason: "google_oauth_secrets_missing" };
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return { ok: false, reason: "google_not_connected" };
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
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
  const data = (await response.json()) as {
    items?: { id?: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
  };
  const busy: GoogleBusyEvent[] = (data.items ?? [])
    .map((event) => ({
      id: event.id,
      title: event.summary,
      startsAt: event.start?.dateTime ?? event.start?.date ?? "",
      endsAt: event.end?.dateTime ?? event.end?.date ?? ""
    }))
    .filter((event) => Boolean(event.startsAt && event.endsAt));
  await writeGoogleBusy(env, busy);
  const availability = await listAvailability(env, timeMin.toISOString(), timeMax.toISOString(), 30, 200);
  return { ok: true, busyWritten: busy.length, availabilityWritten: availability.length };
}

export async function suggestedDurationForChat(env: Env, chatId: string): Promise<number> {
  const schedule = await readSchedule(env);
  const client = (await readUsers(env)).find((user) => user.chatId === chatId);
  if (!client) return schedule.introDurationMinutes || 30;
  const durations = [
    ...(client.agentProfile?.sessionHistory ?? []).map((item) => item.durationMinutes),
    ...(client.manualProfile?.sessionHistory ?? []).map((item) => item.durationMinutes)
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (!durations.length && !client.manualProfile?.modalDurationMinutes && !client.agentProfile?.modalDurationMinutes) {
    return schedule.introDurationMinutes || 30;
  }
  if (!durations.length) return client.manualProfile?.modalDurationMinutes ?? client.agentProfile?.modalDurationMinutes ?? (schedule.defaultSessionMinutes || 60);
  const counts = new Map<number, number>();
  for (const duration of durations) counts.set(duration, (counts.get(duration) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? schedule.defaultSessionMinutes ?? 60;
}

export async function visibleBusyRanges(env: Env, fromIso: string, toIso: string): Promise<BusyRange[]> {
  const [bookings, googleBusy] = await Promise.all([readBookings(env), readGoogleBusy(env)]);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  return [
    ...bookings
      .filter((booking) => booking.status !== "cancelled")
      .map((booking) => ({ startsAt: booking.startsAt, endsAt: booking.endsAt, source: "booking" as const, title: booking.clientName ?? booking.chatId })),
    ...googleBusy.map((busy) => ({ startsAt: busy.startsAt, endsAt: busy.endsAt, source: "google" as const, title: busy.title }))
  ].filter((item) => Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from);
}

export function clientDisplayName(client?: ClientSummary): string | undefined {
  if (!client) return undefined;
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || client.username || client.chatId;
}

async function createGoogleCalendarHold(env: Env, booking: Booking): Promise<string | undefined> {
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return undefined;
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: "Предварительная запись из Telegram-бота",
      description: `Telegram chat_id=${booking.chatId ?? "admin"}; booking_id=${booking.id}; статус=${booking.status}`,
      start: { dateTime: booking.startsAt, timeZone: env.TIMEZONE || "Europe/Moscow" },
      end: { dateTime: booking.endsAt, timeZone: env.TIMEZONE || "Europe/Moscow" }
    })
  });
  if (!response.ok) {
    await appendStoredJsonl(env, "logs/google_event_errors.jsonl", {
      bookingId: booking.id,
      status: response.status,
      body: (await response.text()).slice(0, 500),
      createdAt: new Date().toISOString()
    });
    return undefined;
  }
  const data = (await response.json()) as { id?: string };
  return data.id;
}

async function acquireBookingLock(env: Env): Promise<{ ok: boolean; lockId: string }> {
  const lockId = crypto.randomUUID();
  const response = await appStateStub(env).fetch("https://app-state/lock/acquire?key=booking", {
    method: "POST",
    body: JSON.stringify({ lockId, ttlMs: 10_000 })
  });
  if (!response.ok) return { ok: false, lockId };
  const data = (await response.json()) as { ok: boolean };
  return { ok: data.ok, lockId };
}

async function releaseBookingLock(env: Env, lockId: string): Promise<void> {
  await appStateStub(env).fetch("https://app-state/lock/release?key=booking", {
    method: "POST",
    body: JSON.stringify({ lockId })
  });
}
