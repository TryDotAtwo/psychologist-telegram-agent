import { appendStoredJsonl, readReminders, upsertReminder, writeReminders } from "./storage";
import { escapeTelegramHtml, sendTelegramMessage } from "./telegram";
import type { ClientReminder, Env, ReminderRepeat } from "./types";

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
    sentCount: 0,
    createdAt: now,
    updatedAt: now
  };
  return upsertReminder(env, reminder);
}

export async function updateReminder(env: Env, id: string, patch: Partial<ClientReminder>): Promise<ClientReminder | null> {
  const reminders = await readReminders(env);
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index < 0) return null;
  const current = reminders[index];
  const next: ClientReminder = {
    ...current,
    ...patch,
    id,
    text: (patch.text ?? current.text).trim().slice(0, 500),
    dueAt: patch.dueAt ? new Date(patch.dueAt).toISOString() : current.dueAt,
    repeat: normalizeRepeat(patch.repeat ?? current.repeat),
    sentCount: patch.sentCount ?? current.sentCount ?? 0,
    updatedAt: new Date().toISOString()
  };
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
    await sendTelegramMessage(env, reminder.chatId, `Напоминание:\n${escapeTelegramHtml(reminder.text)}`);
    const sentAt = new Date().toISOString();
    const nextDueAt = nextReminderDueAt(reminder, sentAt);
    return updateReminder(env, reminder.id, {
      status: nextDueAt ? "scheduled" : "sent",
      dueAt: nextDueAt ?? reminder.dueAt,
      sentAt,
      sentCount: (reminder.sentCount ?? 0) + 1,
      lastError: undefined
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

function normalizeRepeat(value: ReminderRepeat | undefined): ReminderRepeat {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none";
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
