import { appendStoredJsonl, readReminders, upsertReminder, writeReminders } from "./storage";
import { escapeTelegramHtml, sendTelegramMessage } from "./telegram";
import type { ClientReminder, Env, ReminderAckStatus, ReminderRepeat } from "./types";

type ReminderPatch = Omit<Partial<ClientReminder>, "ackStatus" | "scheduledFor" | "acknowledgedAt" | "lastError"> & {
  ackStatus?: ReminderAckStatus | null;
  scheduledFor?: string | null;
  acknowledgedAt?: string | null;
  lastError?: string | null;
};

export type ReminderReplyResult = {
  handled: boolean;
  answer: string;
  keyboard?: string[][];
};

const DEFAULT_ACK_INTERVAL_MINUTES = 5;
const REMINDER_ACK_KEYBOARD = [
  ["Сделано"],
  ["Напомнить через 15 минут"],
  ["Не проверять выполнение"]
];

export async function createReminder(
  env: Env,
  input: { chatId: string; text: string; dueAt: string; timezone?: string; source: "agent" | "admin"; repeat?: ReminderRepeat }
): Promise<ClientReminder | null> {
  if (!input.text.trim() || Number.isNaN(Date.parse(input.dueAt))) return null;
  const now = new Date().toISOString();
  const reminder: ClientReminder = {
    id: `reminder_${crypto.randomUUID()}`,
    chatId: input.chatId,
    text: input.text.trim().slice(0, 500),
    dueAt: new Date(input.dueAt).toISOString(),
    timezone: input.timezone || env.TIMEZONE || "Europe/Moscow",
    status: "scheduled",
    source: input.source,
    repeat: normalizeRepeat(input.repeat),
    ackRequired: true,
    ackIntervalMinutes: DEFAULT_ACK_INTERVAL_MINUTES,
    sentCount: 0,
    createdAt: now,
    updatedAt: now
  };
  return upsertReminder(env, reminder);
}

export async function updateReminder(env: Env, id: string, patch: ReminderPatch): Promise<ClientReminder | null> {
  const reminders = await readReminders(env);
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index < 0) return null;
  const current = reminders[index];
  const { ackStatus: _ackStatus, scheduledFor: _scheduledFor, acknowledgedAt: _acknowledgedAt, lastError: _lastError, ...safePatch } = patch;
  const next: ClientReminder = {
    ...current,
    ...safePatch,
    id,
    text: (patch.text ?? current.text).trim().slice(0, 500),
    dueAt: patch.dueAt ? new Date(patch.dueAt).toISOString() : current.dueAt,
    repeat: normalizeRepeat(patch.repeat ?? current.repeat),
    ackRequired: patch.ackRequired ?? current.ackRequired ?? true,
    ackIntervalMinutes: clampAckInterval(patch.ackIntervalMinutes ?? current.ackIntervalMinutes),
    sentCount: patch.sentCount ?? current.sentCount ?? 0,
    updatedAt: new Date().toISOString()
  };
  if (hasOwn(patch, "ackStatus")) {
    if (patch.ackStatus) next.ackStatus = patch.ackStatus;
    else delete next.ackStatus;
  }
  if (hasOwn(patch, "scheduledFor")) {
    if (patch.scheduledFor) next.scheduledFor = new Date(patch.scheduledFor).toISOString();
    else delete next.scheduledFor;
  }
  if (hasOwn(patch, "acknowledgedAt")) {
    if (patch.acknowledgedAt) next.acknowledgedAt = new Date(patch.acknowledgedAt).toISOString();
    else delete next.acknowledgedAt;
  }
  if (hasOwn(patch, "lastError")) {
    if (patch.lastError) next.lastError = patch.lastError;
    else delete next.lastError;
  }
  reminders[index] = next;
  await writeReminders(env, reminders);
  return next;
}

export async function cancelReminder(env: Env, id: string): Promise<ClientReminder | null> {
  return updateReminder(env, id, { status: "cancelled" });
}

export async function sendReminderNow(env: Env, id: string): Promise<ClientReminder | null> {
  const reminders = await readReminders(env);
  const reminder = reminders.find((item) => item.id === id);
  if (!reminder) return null;
  return sendReminder(env, reminder);
}

export async function handleReminderFollowUpResponse(env: Env, chatId: string, text: string): Promise<ReminderReplyResult | null> {
  const reminder = await findPendingReminderForChat(env, chatId);
  if (!reminder) return null;
  const minutes = parseFollowUpDelayMinutes(text);
  if (isReminderDoneText(text)) {
    const updated = await confirmReminderDone(env, reminder);
    if (!updated) return null;
    const repeat = normalizeRepeat(reminder.repeat);
    return {
      handled: true,
      answer: repeat === "none"
        ? "Готово, отметил выполнение напоминания."
        : `Готово, отметил выполнение. Следующее напоминание: ${humanDateTime(updated.dueAt)}.`
    };
  }
  if (isDisableAcknowledgementText(text)) {
    const updated = await disableReminderAcknowledgement(env, reminder);
    if (!updated) return null;
    const repeat = normalizeRepeat(reminder.repeat);
    return {
      handled: true,
      answer: repeat === "none"
        ? "Ок, проверку выполнения убрал."
        : `Ок, проверку выполнения убрал. Само напоминание останется: ${humanDateTime(updated.dueAt)}.`
    };
  }
  if (minutes) {
    const updated = await snoozeReminderAcknowledgement(env, reminder, minutes);
    if (!updated) return null;
    return {
      handled: true,
      answer: `Ок, спрошу про выполнение через ${minutes} минут.`,
      keyboard: REMINDER_ACK_KEYBOARD
    };
  }
  if (isReminderNotDoneText(text)) {
    const interval = reminderAckInterval(reminder);
    const updated = await snoozeReminderAcknowledgement(env, reminder, interval);
    if (!updated) return null;
    return {
      handled: true,
      answer: `Ок, напомню еще раз через ${interval} минут.`,
      keyboard: REMINDER_ACK_KEYBOARD
    };
  }
  return null;
}

export async function processDueReminders(env: Env): Promise<{ checked: number; sent: number; failed: number }> {
  const reminders = await readReminders(env);
  const due = reminders.filter((reminder) => reminder.status === "scheduled" && Date.parse(reminder.dueAt) <= Date.now()).slice(0, 20);
  let sent = 0;
  let failed = 0;
  for (const reminder of due) {
    const result = await sendReminder(env, reminder);
    if (result?.lastError) failed += 1;
    else sent += 1;
  }
  return { checked: due.length, sent, failed };
}

async function sendReminder(env: Env, reminder: ClientReminder): Promise<ClientReminder> {
  try {
    const ackRequired = reminder.ackRequired ?? true;
    const isFollowUp = reminder.ackStatus === "pending";
    const title = isFollowUp ? "Проверка выполнения напоминания" : "Напоминание";
    const actionText = ackRequired
      ? "\n\nКогда выполните, нажмите «Сделано» или напишите свободно: «сделал», «выпил», «принял». Если нужно другое время проверки, напишите, например: «через 15 минут»."
      : "";
    await sendTelegramMessage(env, reminder.chatId, `${title}:\n${escapeTelegramHtml(reminder.text)}${actionText}`, ackRequired ? REMINDER_ACK_KEYBOARD : undefined);
    const sentAt = new Date().toISOString();
    if (ackRequired) {
      return updateReminder(env, reminder.id, {
        status: "scheduled",
        dueAt: addMinutesIso(sentAt, reminderAckInterval(reminder)),
        ackStatus: "pending",
        scheduledFor: reminder.scheduledFor ?? reminder.dueAt,
        sentAt,
        sentCount: (reminder.sentCount ?? 0) + 1,
        lastError: null
      }) as Promise<ClientReminder>;
    }
    const nextDueAt = nextReminderDueAt(reminder, sentAt);
    return updateReminder(env, reminder.id, {
      status: nextDueAt ? "scheduled" : "sent",
      dueAt: nextDueAt ?? reminder.dueAt,
      sentAt,
      sentCount: (reminder.sentCount ?? 0) + 1,
      lastError: null
    }) as Promise<ClientReminder>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendStoredJsonl(env, "logs/reminder_send_errors.jsonl", {
      reminderId: reminder.id,
      chatId: reminder.chatId,
      message,
      createdAt: new Date().toISOString()
    });
    return updateReminder(env, reminder.id, { status: "failed", lastError: message }) as Promise<ClientReminder>;
  }
}

async function findPendingReminderForChat(env: Env, chatId: string): Promise<ClientReminder | null> {
  const reminders = await readReminders(env);
  return reminders
    .filter((reminder) => reminder.chatId === chatId && reminder.status === "scheduled" && reminder.ackStatus === "pending")
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0] ?? null;
}

async function confirmReminderDone(env: Env, reminder: ClientReminder): Promise<ClientReminder | null> {
  const acknowledgedAt = new Date().toISOString();
  const scheduledFor = reminder.scheduledFor ?? reminder.dueAt;
  const nextDueAt = nextReminderDueAt({ ...reminder, dueAt: scheduledFor }, acknowledgedAt);
  return updateReminder(env, reminder.id, {
    status: nextDueAt ? "scheduled" : "sent",
    dueAt: nextDueAt ?? scheduledFor,
    ackStatus: nextDueAt ? null : "confirmed",
    scheduledFor: null,
    acknowledgedAt,
    lastError: null
  });
}

async function disableReminderAcknowledgement(env: Env, reminder: ClientReminder): Promise<ClientReminder | null> {
  const updatedAt = new Date().toISOString();
  const scheduledFor = reminder.scheduledFor ?? reminder.dueAt;
  const nextDueAt = nextReminderDueAt({ ...reminder, dueAt: scheduledFor }, updatedAt);
  return updateReminder(env, reminder.id, {
    status: nextDueAt ? "scheduled" : "sent",
    dueAt: nextDueAt ?? scheduledFor,
    ackRequired: false,
    ackStatus: "disabled",
    scheduledFor: null,
    lastError: null
  });
}

async function snoozeReminderAcknowledgement(env: Env, reminder: ClientReminder, minutes: number): Promise<ClientReminder | null> {
  return updateReminder(env, reminder.id, {
    status: "scheduled",
    dueAt: addMinutesIso(new Date().toISOString(), minutes),
    ackStatus: "pending",
    ackIntervalMinutes: minutes,
    scheduledFor: reminder.scheduledFor ?? reminder.dueAt,
    lastError: null
  });
}

function normalizeRepeat(value: ReminderRepeat | undefined): ReminderRepeat {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none";
}

function reminderAckInterval(reminder: ClientReminder): number {
  return clampAckInterval(reminder.ackIntervalMinutes);
}

function clampAckInterval(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_ACK_INTERVAL_MINUTES;
  return Math.min(24 * 60, Math.max(1, Math.round(value)));
}

function parseFollowUpDelayMinutes(text: string): number | null {
  const normalized = normalizeRu(text);
  const minutes = normalized.match(/(?:через|спроси через|напомни через)\s+(\d{1,3})\s*(?:мин|минут)/i);
  if (minutes) return clampAckInterval(Number(minutes[1]));
  const hours = normalized.match(/(?:через|спроси через|напомни через)\s+(\d{1,2})\s*(?:час|часа|часов|ч)\b/i);
  if (hours) return clampAckInterval(Number(hours[1]) * 60);
  if (/через\s+час\b/i.test(normalized)) return 60;
  return null;
}

function isReminderDoneText(text: string): boolean {
  const normalized = normalizeRu(text);
  if (isReminderNotDoneText(normalized)) return false;
  return /^(сделано|готово|выполнено|сделал|сделала|я сделал|я сделала|выпил|выпила|принял|приняла|препарат принят|таблетку выпил|таблетку выпила)$/i.test(normalized)
    || /\b(сделал|сделала|выполнил|выполнила|выпил|выпила|принял|приняла)\b/i.test(normalized);
}

function isReminderNotDoneText(text: string): boolean {
  return /^(не сделал|не сделала|еще нет|пока нет|не выпил|не выпила|не принял|не приняла|позже)$/i.test(normalizeRu(text));
}

function isDisableAcknowledgementText(text: string): boolean {
  return /^(не проверять выполнение|не спрашивать выполнение|не спрашивай|не проверяй|убери проверку|отключи проверку|без проверки)$/i.test(normalizeRu(text));
}

function nextReminderDueAt(reminder: ClientReminder, sentAt: string): string | null {
  const repeat = normalizeRepeat(reminder.repeat);
  if (repeat === "none") return null;
  const sentTime = Date.parse(sentAt);
  let next = new Date(reminder.dueAt);
  for (let guard = 0; guard < 370 && next.getTime() <= sentTime; guard += 1) {
    next = addRepeat(next, repeat);
  }
  return next.toISOString();
}

function addRepeat(date: Date, repeat: ReminderRepeat): Date {
  const next = new Date(date);
  if (repeat === "daily") next.setUTCDate(next.getUTCDate() + 1);
  if (repeat === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  if (repeat === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function addMinutesIso(value: string, minutes: number): string {
  return new Date(Date.parse(value) + minutes * 60 * 1000).toISOString();
}

function humanDateTime(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

function normalizeRu(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
