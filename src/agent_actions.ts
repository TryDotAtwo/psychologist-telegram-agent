import { createBooking, listAvailability } from "./calendar";
import { extractAgentActionPlan, type AgentActionPlan } from "./openai";
import { createReminder } from "./reminders";
import { appendStoredJsonl, upsertClient } from "./storage";
import { escapeTelegramHtml, formatAvailability } from "./telegram";
import type { BotConfig, ClientProfileData, ClientSummary, Env, PendingAction } from "./types";

type ConversationContext = { profile: unknown; turns: { role: string; text: string; createdAt: string }[] };

export type ActionFlowResult = {
  handled: boolean;
  answer: string;
  keyboard?: string[][];
};

const CONFIRM_KEYBOARD = [
  ["Да", "Нет"],
  ["Внести корректировки"]
];

const CORRECTION_KEYBOARD = [["Внести корректировки", "Нет"]];

export async function handleAgentActionFlow(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  context: ConversationContext
): Promise<ActionFlowResult | null> {
  if (client.pendingAction) return handlePendingAction(env, config, chatId, text, client, context);
  const plan = await extractAgentActionPlan(env, config, text, context);
  if (!plan) {
    await logActionExtractionMiss(env, chatId, text, "new_action");
    return null;
  }
  if (plan.kind === "none" || plan.confidence < 0.55) return null;
  const pending = toPendingAction(plan, text);
  await upsertClient(env, { chatId, pendingAction: pending });
  return {
    handled: true,
    answer: formatPendingAction(pending),
    keyboard: pending.missingFields.length ? CORRECTION_KEYBOARD : CONFIRM_KEYBOARD
  };
}

async function handlePendingAction(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  context: ConversationContext
): Promise<ActionFlowResult> {
  const existingAction = client.pendingAction;
  if (!existingAction) return { handled: false, answer: "" };
  const normalized = text.trim().toLowerCase();
  if (isPositive(normalized)) return executePendingAction(env, chatId, existingAction);
  if (isNegative(normalized)) {
    await upsertClient(env, { chatId, pendingAction: undefined });
    return { handled: true, answer: "Ок, действие отменено." };
  }
  if (isCorrectionButton(normalized)) {
    return { handled: true, answer: "Напишите, что именно исправить. Я обновлю поля и снова попрошу подтверждение.", keyboard: CORRECTION_KEYBOARD };
  }

  const plan = await extractAgentActionPlan(env, config, text, context, existingAction);
  if (!plan || plan.kind === "none") {
    if (!plan) await logActionExtractionMiss(env, chatId, text, "pending_correction");
    return {
      handled: true,
      answer: "Не смог надежно разобрать правку. Напишите одним сообщением, что изменить: дату, время, длительность, текст или повтор.",
      keyboard: CORRECTION_KEYBOARD
    };
  }
  const pending = toPendingAction(plan, existingAction.originalText, existingAction);
  await upsertClient(env, { chatId, pendingAction: pending });
  return {
    handled: true,
    answer: formatPendingAction(pending),
    keyboard: pending.missingFields.length ? CORRECTION_KEYBOARD : CONFIRM_KEYBOARD
  };
}

async function executePendingAction(env: Env, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  if (action.missingFields.length) {
    return {
      handled: true,
      answer: `Подтверждать пока рано. Не хватает: ${safe(action.missingFields.join(", "))}. Напишите недостающие данные одним сообщением.`,
      keyboard: CORRECTION_KEYBOARD
    };
  }
  if (action.kind === "reminder_create") return executeReminderAction(env, chatId, action);
  if (action.kind === "booking_create") return executeBookingAction(env, chatId, action);
  return executeProfileAction(env, chatId, action);
}

async function executeReminderAction(env: Env, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  const text = stringField(action.fields.text);
  const repeat = repeatField(action.fields.repeat);
  const dueAt = normalizeDueAt(action.fields.dueAt, repeat);
  if (!text || !dueAt) {
    const pending = { ...action, missingFields: missing(action.fields, action.kind), updatedAt: new Date().toISOString() };
    await upsertClient(env, { chatId, pendingAction: pending });
    return { handled: true, answer: formatPendingAction(pending), keyboard: CORRECTION_KEYBOARD };
  }
  const reminder = await createReminder(env, { chatId, text, dueAt, timezone: env.TIMEZONE || "Europe/Moscow", repeat, source: "agent" });
  await upsertClient(env, {
    chatId,
    pendingAction: undefined,
    agentProfile: { reminders: [`${text}; ${repeatLabel(repeat)}; первый раз ${humanDateTime(dueAt)}`] }
  });
  if (!reminder) return { handled: true, answer: "Не удалось создать напоминание. Проверьте дату и время, затем попробуйте еще раз." };
  return { handled: true, answer: `Готово. Напоминание создано.\n\nТекст: ${safe(text)}\nКогда: ${safe(repeatLabel(repeat))}\nПервый раз: ${safe(humanDateTime(reminder.dueAt))}` };
}

async function executeBookingAction(env: Env, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  const startsAt = bookingStartsAt(action.fields);
  const durationMinutes = numberField(action.fields.durationMinutes);
  if (!startsAt || !durationMinutes) {
    const pending = { ...action, missingFields: missing(action.fields, action.kind), updatedAt: new Date().toISOString() };
    await upsertClient(env, { chatId, pendingAction: pending });
    return { handled: true, answer: formatPendingAction(pending), keyboard: CORRECTION_KEYBOARD };
  }
  const dayStart = dateKey(startsAt);
  const availability = await listAvailability(env, `${dayStart}T00:00:00+03:00`, `${addDays(dayStart, 1)}T00:00:00+03:00`, durationMinutes, 200);
  const slot = availability.find((item) => Math.abs(Date.parse(item.startsAt) - Date.parse(startsAt)) < 60_000);
  if (!slot) {
    const alternatives = availability.slice(0, 5);
    const pending = { ...action, missingFields: ["другое доступное время"], updatedAt: new Date().toISOString() };
    await upsertClient(env, { chatId, pendingAction: pending });
    const options = alternatives.length ? `\n\nДоступные варианты на этот день:\n${formatAvailability(alternatives, durationMinutes, false)}` : "";
    return {
      handled: true,
      answer: `Это время сейчас недоступно для записи. Напишите другое время или отмените действие.${options}`,
      keyboard: CORRECTION_KEYBOARD
    };
  }
  const booking = await createBooking(env, {
    availabilityId: slot.id,
    chatId,
    durationMinutes,
    source: "bot",
    status: "booked"
  });
  if (!booking) return { handled: true, answer: "Не получилось записать: окно уже занято. Напишите другое время.", keyboard: CORRECTION_KEYBOARD };
  await upsertClient(env, {
    chatId,
    pendingAction: undefined,
    agentProfile: {
      sessionHistory: [{ startsAt: booking.startsAt, durationMinutes: booking.durationMinutes, serviceId: stringField(action.fields.serviceId) }],
      modalDurationMinutes: booking.durationMinutes
    }
  });
  return { handled: true, answer: `Готово. Запись создана.\n\nКогда: ${safe(humanDateTime(booking.startsAt))}\nДлительность: ${booking.durationMinutes} минут.` };
}

async function executeProfileAction(env: Env, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  const profile = profileField(action.fields.profile);
  const tags = stringList(action.fields.tags);
  const nextAction = stringField(action.fields.nextAction);
  const riskLevel = riskField(action.fields.riskLevel);
  const patch: Parameters<typeof upsertClient>[1] = {
    chatId,
    pendingAction: undefined,
    tags,
    agentProfile: profile
  };
  if (nextAction) patch.nextAction = nextAction;
  if (riskLevel) patch.riskLevel = riskLevel;
  await upsertClient(env, patch);
  return { handled: true, answer: "Готово. Информация добавлена в профиль клиента." };
}

function toPendingAction(plan: AgentActionPlan, originalText: string, existing?: PendingAction): PendingAction {
  const now = new Date().toISOString();
  const fields = mergeFields(existing?.fields ?? {}, plan.fields ?? {});
  const kind = plan.kind === "none" ? existing?.kind ?? "profile_update" : plan.kind;
  return {
    id: existing?.id ?? `pending_${crypto.randomUUID()}`,
    kind,
    summary: plan.summary || existing?.summary || actionTitle(kind),
    fields,
    missingFields: missing(fields, kind),
    originalText,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

function formatPendingAction(action: PendingAction): string {
  const lines = [`Понял задачу: ${safe(actionTitle(action.kind))}.`];
  if (action.kind === "reminder_create") {
    const reminderDueAt = normalizeDueAt(action.fields.dueAt, repeatField(action.fields.repeat)) || stringField(action.fields.dueAt) || "";
    lines.push("", "Что будет сделано:");
    lines.push(`Текст: ${safe(stringField(action.fields.text) || "не указан")}`);
    lines.push(`Повтор: ${safe(repeatLabel(repeatField(action.fields.repeat)))}`);
    lines.push(`Первый раз: ${safe(humanDateTime(reminderDueAt)) || "не указано"}`);
  } else if (action.kind === "booking_create") {
    lines.push("", "Что будет сделано:");
    lines.push(`Дата и время: ${safe(humanDateTime(bookingStartsAt(action.fields) || "") || "не указано")}`);
    lines.push(`Длительность: ${numberField(action.fields.durationMinutes) || "не указана"} минут`);
    if (stringField(action.fields.serviceId)) lines.push(`Тип: ${safe(stringField(action.fields.serviceId) as string)}`);
  } else {
    lines.push("", "Что будет добавлено в профиль:");
    lines.push(...formatProfileFields(action.fields));
  }
  if (action.missingFields.length) {
    lines.push("", `Не хватает: ${safe(action.missingFields.join(", "))}.`);
    lines.push("Напишите недостающие данные или нажмите «Нет», чтобы отменить.");
  } else {
    lines.push("", "Подтверждаете?");
  }
  return lines.join("\n");
}

function formatProfileFields(fields: Record<string, unknown>): string[] {
  const profile = profileField(fields.profile);
  const rows = [
    ["Теги", stringList(fields.tags)],
    ["Факты", profile.facts],
    ["Лекарства", profile.medications],
    ["Врачи", profile.doctors],
    ["Встречи", profile.appointments],
    ["Проблемы", profile.problems],
    ["Предпочтения", profile.preferences],
    ["Риск", profile.riskNotes]
  ].filter(([, values]) => Array.isArray(values) && values.length);
  if (!rows.length && stringField(fields.nextAction)) return [`Следующее действие: ${safe(stringField(fields.nextAction) as string)}`];
  return rows.length ? rows.map(([label, values]) => `${label}: ${safe((values as string[]).join("; "))}`) : ["Данные: не указаны"];
}

function missing(fields: Record<string, unknown>, kind: PendingAction["kind"]): string[] {
  if (kind === "reminder_create") {
    return [
      stringField(fields.text) ? "" : "текст напоминания",
      normalizeDueAt(fields.dueAt, repeatField(fields.repeat)) ? "" : "дата и время"
    ].filter(Boolean);
  }
  if (kind === "booking_create") {
    return [bookingStartsAt(fields) ? "" : "дата и время", numberField(fields.durationMinutes) ? "" : "длительность"].filter(Boolean);
  }
  const profile = profileField(fields.profile);
  return stringList(fields.tags).length || stringField(fields.nextAction) || Object.values(profile).some((value) => Array.isArray(value) && value.length) ? [] : ["что добавить в профиль"];
}

function mergeFields(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      next[key] = [...new Set([...(Array.isArray(next[key]) ? (next[key] as string[]) : []), ...value.map(String)])];
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      next[key] = mergeFields((next[key] && typeof next[key] === "object" ? (next[key] as Record<string, unknown>) : {}), value as Record<string, unknown>);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function bookingStartsAt(fields: Record<string, unknown>): string | undefined {
  const startsAt = stringField(fields.startsAt);
  if (startsAt && Number.isFinite(Date.parse(startsAt))) return new Date(startsAt).toISOString();
  const date = stringField(fields.date);
  const time = stringField(fields.time);
  if (date && time && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}$/.test(time)) {
    const normalizedTime = time.length === 4 ? `0${time}` : time;
    const iso = `${date}T${normalizedTime}:00+03:00`;
    if (Number.isFinite(Date.parse(iso))) return iso;
  }
  return undefined;
}

function normalizeDueAt(value: unknown, repeat: string): string | undefined {
  const raw = stringField(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  let date = new Date(raw);
  if (repeat !== "none") {
    while (date.getTime() <= Date.now()) date = addRepeat(date, repeat);
  }
  return date.toISOString();
}

function addRepeat(date: Date, repeat: string): Date {
  const next = new Date(date);
  if (repeat === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (repeat === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else if (repeat === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function actionTitle(kind: PendingAction["kind"]): string {
  if (kind === "reminder_create") return "создать напоминание";
  if (kind === "booking_create") return "создать запись";
  return "обновить профиль";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 30) : [];
}

function profileField(value: unknown): Partial<ClientProfileData> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    facts: stringList(source.facts),
    medications: stringList(source.medications),
    doctors: stringList(source.doctors),
    appointments: stringList(source.appointments),
    problems: stringList(source.problems),
    preferences: stringList(source.preferences),
    riskNotes: stringList(source.riskNotes),
    reminders: stringList(source.reminders)
  };
}

function repeatField(value: unknown): "none" | "daily" | "weekly" | "monthly" {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none";
}

function riskField(value: unknown): "none" | "watch" | "urgent" | undefined {
  return value === "watch" || value === "urgent" || value === "none" ? value : undefined;
}

function repeatLabel(repeat: string): string {
  if (repeat === "daily") return "каждый день";
  if (repeat === "weekly") return "каждую неделю";
  if (repeat === "monthly") return "каждый месяц";
  return "один раз";
}

function isPositive(value: string): boolean {
  return /^(да|подтверждаю|подтвердить|ок|okay|yes|\+|согласен|согласна|верно|делай)$/i.test(value);
}

function isNegative(value: string): boolean {
  return /^(нет|не надо|отмена|отмени|отклонить|не подтверждаю|стоп)$/i.test(value);
}

function isCorrectionButton(value: string): boolean {
  return /^(внести корректировки|исправить|поправить|изменить)$/i.test(value);
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

function dateKey(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function addDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T12:00:00+03:00`) + days * 24 * 60 * 60 * 1000;
  return dateKey(new Date(timestamp).toISOString());
}

function safe(value: string): string {
  return escapeTelegramHtml(value);
}

async function logActionExtractionMiss(env: Env, chatId: string, text: string, phase: string): Promise<void> {
  await appendStoredJsonl(env, "logs/action_extract_errors.jsonl", {
    chatId,
    phase,
    text: text.slice(0, 500),
    createdAt: new Date().toISOString()
  });
}
