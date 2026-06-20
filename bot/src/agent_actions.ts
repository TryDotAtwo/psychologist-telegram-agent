import { createBooking, listAvailability, suggestedDurationForChat } from "./calendar";
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
  const effectivePlan = isActionPlanUsable(plan) ? plan : await fallbackAgentActionPlan(env, config, chatId, text, client);
  if (!effectivePlan) {
    await logActionExtractionMiss(env, chatId, text, "new_action");
    return null;
  }
  const enrichedPlan = await enrichActionPlanDefaults(env, config, chatId, text, client, effectivePlan);
  const pending = toPendingAction(enrichedPlan, text);
  await upsertClient(env, { chatId, pendingAction: pending });
  return {
    handled: true,
    answer: formatPendingAction(pending, config),
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
  if (isPositive(normalized)) return executePendingAction(env, config, chatId, existingAction);
  if (isNegative(normalized)) {
    await upsertClient(env, { chatId, pendingAction: undefined });
    return { handled: true, answer: "Ок, действие отменено." };
  }
  if (isCorrectionButton(normalized)) {
    return { handled: true, answer: "Напишите, что именно исправить. Я обновлю поля и снова попрошу подтверждение.", keyboard: CORRECTION_KEYBOARD };
  }

  const plan = await extractAgentActionPlan(env, config, text, context, existingAction);
  const effectivePlan = isActionPlanUsable(plan)
    ? { ...plan, kind: plan.kind === existingAction.kind ? plan.kind : existingAction.kind }
    : await fallbackAgentActionPlan(env, config, chatId, text, client, existingAction);
  if (!effectivePlan) {
    if (!plan) await logActionExtractionMiss(env, chatId, text, "pending_correction");
    return {
      handled: true,
      answer: "Не смог надежно разобрать правку. Напишите одним сообщением, что изменить: дату, время, длительность, текст или повтор.",
      keyboard: CORRECTION_KEYBOARD
    };
  }
  const enrichedPlan = await enrichActionPlanDefaults(env, config, chatId, text, client, effectivePlan, existingAction);
  const pending = toPendingAction(enrichedPlan, existingAction.originalText, existingAction);
  await upsertClient(env, { chatId, pendingAction: pending });
  return {
    handled: true,
    answer: formatPendingAction(pending, config),
    keyboard: pending.missingFields.length ? CORRECTION_KEYBOARD : CONFIRM_KEYBOARD
  };
}

async function executePendingAction(env: Env, config: BotConfig, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  if (action.missingFields.length) {
    return {
      handled: true,
      answer: `Подтверждать пока рано. Не хватает: ${safe(action.missingFields.join(", "))}. Напишите недостающие данные одним сообщением.`,
      keyboard: CORRECTION_KEYBOARD
    };
  }
  if (action.kind === "reminder_create") return executeReminderAction(env, chatId, action);
  if (action.kind === "booking_create") return executeBookingAction(env, config, chatId, action);
  return executeProfileAction(env, chatId, action);
}

async function executeReminderAction(env: Env, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  const text = normalizeReminderText(stringField(action.fields.text) || "");
  const medicationName = medicationField(action.fields.medicationName) || extractMedicationName(text);
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
    agentProfile: {
      reminders: [`${text}; ${repeatLabel(repeat)}; первый раз ${humanDateTime(dueAt)}`],
      medications: medicationName ? [`Клиент попросил напоминание о препарате: ${medicationName}`] : []
    }
  });
  if (!reminder) return { handled: true, answer: "Не удалось создать напоминание. Проверьте дату и время, затем попробуйте еще раз." };
  const medicationLine = medicationName ? `\nПрепарат: ${safe(medicationName)}` : "";
  return { handled: true, answer: `Готово. Напоминание создано.\n\nТип: ${medicationName ? "прием препарата" : "обычное напоминание"}${medicationLine}\nТекст: ${safe(text)}\nКогда: ${safe(repeatLabel(repeat))}\nПервый раз: ${safe(humanDateTime(reminder.dueAt))}\nПроверка выполнения: буду ждать «Сделано»; если ответа не будет, повторю через 5 минут.` };
}

async function executeBookingAction(env: Env, config: BotConfig, chatId: string, action: PendingAction): Promise<ActionFlowResult> {
  const startsAt = bookingStartsAt(action.fields);
  const durationMinutes = numberField(action.fields.durationMinutes);
  if (!startsAt || !durationMinutes) {
    const pending = { ...action, missingFields: missing(action.fields, action.kind), updatedAt: new Date().toISOString() };
    await upsertClient(env, { chatId, pendingAction: pending });
    return { handled: true, answer: formatPendingAction(pending, config), keyboard: CORRECTION_KEYBOARD };
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
  const serviceId = stringField(action.fields.serviceId);
  const serviceName = serviceTitle(config, serviceId, booking.durationMinutes);
  await upsertClient(env, {
    chatId,
    pendingAction: undefined,
    agentProfile: {
      sessionHistory: [{ startsAt: booking.startsAt, durationMinutes: booking.durationMinutes, serviceId }],
      modalDurationMinutes: booking.durationMinutes
    }
  });
  return { handled: true, answer: `Готово. Запись создана.\n\nУслуга: ${safe(serviceName)}\nКогда: ${safe(humanDateTime(booking.startsAt))}\nДлительность: ${booking.durationMinutes} минут.` };
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

function isActionPlanUsable(plan: AgentActionPlan | null): plan is AgentActionPlan & { kind: PendingAction["kind"] } {
  return Boolean(plan && plan.kind !== "none" && plan.confidence >= 0.55);
}

async function fallbackAgentActionPlan(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  existingAction?: PendingAction
): Promise<(AgentActionPlan & { kind: PendingAction["kind"] }) | null> {
  if (existingAction?.kind === "reminder_create" || (!existingAction && hasReminderIntent(text))) {
    return fallbackReminderPlan(env, text);
  }
  if (existingAction?.kind === "booking_create" || (!existingAction && hasBookingIntent(text))) {
    return fallbackBookingPlan(env, config, chatId, text, client, existingAction);
  }
  if (existingAction?.kind === "profile_update" || (!existingAction && hasProfileUpdateIntent(text))) {
    return fallbackProfilePlan(text);
  }
  return null;
}

async function enrichActionPlanDefaults(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  plan: AgentActionPlan & { kind: PendingAction["kind"] },
  existingAction?: PendingAction
): Promise<AgentActionPlan & { kind: PendingAction["kind"] }> {
  if (plan.kind === "reminder_create") return { ...plan, fields: enrichReminderFields(env, text, plan.fields ?? {}, existingAction) };
  if (plan.kind === "booking_create") {
    return { ...plan, fields: await enrichBookingFields(env, config, chatId, text, client, plan.fields ?? {}, existingAction) };
  }
  return { ...plan, fields: enrichProfileFields(text, plan.fields ?? {}) };
}

async function fallbackReminderPlan(env: Env, text: string): Promise<AgentActionPlan & { kind: "reminder_create" }> {
  const fields = enrichReminderFields(env, text, {});
  return {
    kind: "reminder_create",
    confidence: 0.9,
    summary: "Создать напоминание по сообщению клиента",
    fields
  };
}

async function fallbackBookingPlan(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  existingAction?: PendingAction
): Promise<AgentActionPlan & { kind: "booking_create" }> {
  const fields = await enrichBookingFields(env, config, chatId, text, client, {}, existingAction);
  return {
    kind: "booking_create",
    confidence: 0.9,
    summary: "Создать запись по сообщению клиента",
    fields
  };
}

function fallbackProfilePlan(text: string): AgentActionPlan & { kind: "profile_update" } {
  const fields = enrichProfileFields(text, {});
  return {
    kind: "profile_update",
    confidence: 0.9,
    summary: "Добавить информацию в профиль клиента",
    fields
  };
}

function enrichReminderFields(env: Env, text: string, current: Record<string, unknown>, existingAction?: PendingAction): Record<string, unknown> {
  const fields = { ...current };
  const repeat = repeatFromText(text);
  const dueAt = buildReminderDueAt(text, repeat || repeatField(fields.repeat), env.TIMEZONE || "Europe/Moscow");
  const reminderText = extractReminderText(text);
  const normalizedText = normalizeReminderText(stringField(fields.text) || reminderText || "");
  const medicationName = medicationField(fields.medicationName) || extractMedicationName(normalizedText) || extractMedicationName(text);
  if (normalizedText) fields.text = medicationName ? normalizeReminderText(replaceMedicationName(normalizedText, medicationName)) : normalizedText;
  if (medicationName) {
    fields.medicationName = medicationName;
    fields.reminderKind = "medication";
  } else if (!stringField(fields.reminderKind)) {
    fields.reminderKind = "general";
  }
  if (!stringField(fields.dueAt) && dueAt) fields.dueAt = dueAt;
  if (!stringField(fields.timezone)) fields.timezone = env.TIMEZONE || "Europe/Moscow";
  if (!stringField(fields.repeat)) fields.repeat = repeat || repeatField(existingAction?.fields.repeat) || "none";
  return fields;
}

async function enrichBookingFields(
  env: Env,
  config: BotConfig,
  chatId: string,
  text: string,
  client: ClientSummary,
  current: Record<string, unknown>,
  existingAction?: PendingAction
): Promise<Record<string, unknown>> {
  const fields = { ...current };
  const parsedDate = parseRequestedDateKey(text);
  const parsedTime = parseClockTime(text);
  const parsedDuration = parseDurationMinutes(text);
  const existingStartsAt = existingAction ? bookingStartsAt(existingAction.fields) : undefined;
  const existingDuration = existingAction ? numberField(existingAction.fields.durationMinutes) : undefined;
  const hasPreviousSessions = clientHasSessions(client);
  const duration = parsedDuration ?? numberField(fields.durationMinutes) ?? existingDuration ?? (await suggestedDurationForChat(env, chatId));

  if (!stringField(fields.startsAt) && !stringField(fields.date) && !existingStartsAt) fields.date = parsedDate ?? todayDateKey();
  else if (!stringField(fields.date) && parsedDate) fields.date = parsedDate;
  if (!stringField(fields.startsAt) && !stringField(fields.time) && parsedTime) fields.time = parsedTime;
  if (!numberField(fields.durationMinutes)) fields.durationMinutes = duration;
  if (!stringField(fields.serviceId)) fields.serviceId = serviceIdForBooking(config, text, duration, hasPreviousSessions);
  return fields;
}

function enrichProfileFields(text: string, current: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...current };
  const currentProfile = profileField(fields.profile);
  const fact = extractProfileFact(text);
  if (!stringList(fields.tags).length) fields.tags = ["профиль"];
  if (!currentProfile.facts?.length && fact) {
    fields.profile = { ...currentProfile, facts: [fact] };
  }
  return fields;
}

function hasReminderIntent(text: string): boolean {
  return /(напомн|напоминалк|напоминание|будильник)/i.test(text);
}

function hasBookingIntent(text: string): boolean {
  return /(запиши|записать|записаться|забронируй|забронировать|бронь|забронь|поставь\s+(?:встреч|при[её]м)|хочу\s+(?:на\s+)?(?:при[её]м|консультац|запис))/i.test(text);
}

function hasProfileUpdateIntent(text: string): boolean {
  return /(запомни|сохрани|добавь\s+(?:в\s+)?(?:профил|карточк|памят)|внеси\s+(?:в\s+)?(?:профил|карточк|памят))/i.test(text);
}

function repeatFromText(text: string): "none" | "daily" | "weekly" | "monthly" | undefined {
  const normalized = normalizeRu(text);
  if (/кажд[ыи]й\s+день|ежедневн|каждое\s+утро|каждый\s+вечер/.test(normalized)) return "daily";
  if (/кажд[уюа]?\s+недел|еженедельн/.test(normalized)) return "weekly";
  if (/кажд[ыи]й\s+месяц|ежемесячн/.test(normalized)) return "monthly";
  if (/один\s+раз|разово|единоразово/.test(normalized)) return "none";
  return undefined;
}

function buildReminderDueAt(text: string, repeat: string, timezone: string): string | undefined {
  const time = parseClockTime(text);
  if (!time) return undefined;
  const date = parseRequestedDateKey(text) ?? todayDateKey(timezone);
  return `${date}T${time}:00+03:00`;
}

function extractReminderText(text: string): string | undefined {
  const normalized = text
    .replace(/^.*?(?:напомни(?:ть)?|напоминание|напоминалку|напоминалка|будильник)\s*(?:мне|меня)?\s*/iu, "")
    .replace(/\bкажд[ыи]й\s+день\b/giu, "")
    .replace(/\bежедневно\b/giu, "")
    .replace(/\bкажд[уюа]?\s+неделю\b/giu, "")
    .replace(/\bеженедельно\b/giu, "")
    .replace(/\bкажд[ыи]й\s+месяц\b/giu, "")
    .replace(/\bежемесячно\b/giu, "")
    .replace(/(?:^|[\s,.;])(?:в|на|к|с|около)\s+[01]?\d(?::[0-5]\d)?\s*(?:час(?:ов|а)?|ч)?\b/giu, " ")
    .replace(/(?:^|[\s,.;])(?:в|на|к|с|около)\s+2[0-3](?::[0-5]\d)?\s*(?:час(?:ов|а)?|ч)?\b/giu, " ")
    .replace(/\b[01]?\d[:.][0-5]\d\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(о\s+том,?\s+что|что)\s+/iu, "")
    .trim();
  return normalized.length >= 3 ? normalized.slice(0, 500) : undefined;
}

function normalizeReminderText(value: string): string {
  const trimmed = value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\bкажд[ыи]й\s+день\b/giu, "")
    .replace(/\bежедневно\b/giu, "")
    .replace(/\bкажд[уюа]?\s+неделю\b/giu, "")
    .replace(/\bеженедельно\b/giu, "")
    .replace(/\bкажд[ыи]й\s+месяц\b/giu, "")
    .replace(/\bежемесячно\b/giu, "")
    .replace(/(?:^|[\s,.;])(?:в|на|к|с|около)\s+(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:час(?:ов|а)?|ч)?\b/giu, " ")
    .replace(/\bкажди[йи]\b/giu, "каждый")
    .replace(/\bкаждии\b/giu, "каждый")
    .replace(/\bкаждуюю\b/giu, "каждую")
    .replace(/\bдулокситин\b/giu, "Дулоксетин")
    .replace(/\bдулоксетин\b/giu, "Дулоксетин")
    .trim();
  if (!trimmed) return "";
  const medicationName = extractMedicationName(trimmed);
  const withMedication = medicationName ? replaceMedicationName(trimmed, medicationName) : trimmed;
  return `${withMedication[0].toLocaleUpperCase("ru-RU")}${withMedication.slice(1)}`.slice(0, 500);
}

function extractMedicationName(value: string): string | undefined {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\b(каждый|каждую|ежедневно|еженедельно|ежемесячно|сегодня|завтра|послезавтра)\b.*$/iu, "")
    .trim();
  const match = normalized.match(
    /(?:\bпить\b|\bвыпить\b|\bпринять\b|\bпринимать\b|\bлекарство\b|\bпрепарат\b|\bтаблетк[ауи]?\b)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9-]{2,}(?:\s+[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9-]{2,}){0,2})/iu
  );
  const raw = (match?.[1] || "")
    .replace(/\b(?:в|на|к|с|около)\s+\d{1,2}(?::\d{2})?\b.*$/iu, "")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
  return raw ? normalizeMedicationName(raw) : undefined;
}

function medicationField(value: unknown): string | undefined {
  const raw = stringField(value);
  return raw ? normalizeMedicationName(raw) : undefined;
}

function replaceMedicationName(text: string, medicationName: string): string {
  const escaped = medicationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const known = knownMedicationPattern(medicationName);
  const pattern = known ?? new RegExp(escaped, "iu");
  if (pattern.test(text)) return text.replace(pattern, medicationName);
  return text;
}

function normalizeMedicationName(value: string): string {
  const normalized = normalizeRu(value).replace(/[^a-zа-я0-9- ]/giu, "").trim();
  const known: { name: string; pattern: RegExp }[] = [
    { name: "Дулоксетин", pattern: /дулокс[еи]тин|duloxetin|duloxetine/i },
    { name: "Сертралин", pattern: /сертралин|sertraline/i },
    { name: "Эсциталопрам", pattern: /эсциталопрам|escitalopram/i },
    { name: "Флуоксетин", pattern: /флуоксетин|fluoxetine/i },
    { name: "Венлафаксин", pattern: /венлафаксин|venlafaxine/i },
    { name: "Атомоксетин", pattern: /атомоксетин|atomoxetine/i },
    { name: "Ламотриджин", pattern: /ламотриджин|lamotrigine/i },
    { name: "Кветиапин", pattern: /кветиапин|quetiapine/i }
  ];
  const found = known.find((item) => item.pattern.test(normalized));
  if (found) return found.name;
  return value
    .split(/\s+/)
    .map((part) => (part ? `${part[0].toLocaleUpperCase("ru-RU")}${part.slice(1).toLocaleLowerCase("ru-RU")}` : ""))
    .join(" ")
    .slice(0, 120);
}

function knownMedicationPattern(medicationName: string): RegExp | undefined {
  if (medicationName === "Дулоксетин") return /дулокс[еи]тин|duloxetin|duloxetine/iu;
  if (medicationName === "Сертралин") return /сертралин|sertraline/iu;
  if (medicationName === "Эсциталопрам") return /эсциталопрам|escitalopram/iu;
  if (medicationName === "Флуоксетин") return /флуоксетин|fluoxetine/iu;
  if (medicationName === "Венлафаксин") return /венлафаксин|venlafaxine/iu;
  if (medicationName === "Атомоксетин") return /атомоксетин|atomoxetine/iu;
  if (medicationName === "Ламотриджин") return /ламотриджин|lamotrigine/iu;
  if (medicationName === "Кветиапин") return /кветиапин|quetiapine/iu;
  return undefined;
}

function parseRequestedDateKey(text: string): string | undefined {
  const normalized = normalizeRu(text);
  const today = todayDateKey();
  if (/сегодня/.test(normalized)) return today;
  if (/послезавтра/.test(normalized)) return addDays(today, 2);
  if (/завтра/.test(normalized)) return addDays(today, 1);
  const weekday = [
    { index: 1, pattern: /понед|пн\b/ },
    { index: 2, pattern: /вторн|вт\b/ },
    { index: 3, pattern: /сред|ср\b/ },
    { index: 4, pattern: /четвер|чт\b/ },
    { index: 5, pattern: /пятниц|пт\b/ },
    { index: 6, pattern: /суббот|сб\b/ },
    { index: 0, pattern: /воскрес|вскр|вс\b/ }
  ].find((item) => item.pattern.test(normalized));
  if (weekday) return nextWeekdayDateKey(today, weekday.index);
  const numericDate = normalized.match(/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/);
  if (!numericDate) return undefined;
  const day = Number(numericDate[1]);
  const month = Number(numericDate[2]);
  const currentYear = Number(today.slice(0, 4));
  const rawYear = numericDate[3] ? Number(numericDate[3]) : currentYear;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const candidate = dateKeyFromParts(year, month, day);
  if (!candidate) return undefined;
  return numericDate[3] || candidate >= today ? candidate : dateKeyFromParts(year + 1, month, day);
}

function parseClockTime(text: string): string | undefined {
  const normalized = normalizeRu(text);
  const exact = normalized.match(/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/);
  if (exact) return hhmm(exact[1], exact[2]);
  const hourWord = normalized.match(/(?:^|[^\d])([01]?\d|2[0-3])\s*(?:час(?:ов|а)?|ч)\b/);
  if (hourWord) return hhmm(hourWord[1], "00");
  const prefixed = normalized.match(/(?:^|[\s,.;])(?:в|на|к|с|около)\s+([01]?\d|2[0-3])(?:[:.]([0-5]\d)|\s*(?:час(?:ов|а)?|ч)\b|\b(?!\s*мин))/);
  return prefixed ? hhmm(prefixed[1], prefixed[2] ?? "00") : undefined;
}

function parseDurationMinutes(text: string): number | undefined {
  const normalized = normalizeRu(text);
  if (/полчас/.test(normalized)) return 30;
  const minutes = normalized.match(/\b(\d{1,3})\s*[- ]?(?:мин|минут)\b/);
  if (minutes) return clampDuration(Number(minutes[1]));
  const hours = normalized.match(/\b(?:длительность|на)\s+(\d{1,2})\s*(?:час|ч)\b/);
  if (hours) return clampDuration(Number(hours[1]) * 60);
  return undefined;
}

function serviceIdForBooking(config: BotConfig, text: string, durationMinutes: number, hasPreviousSessions: boolean): string | undefined {
  const normalized = normalizeRu(text);
  const introRequested = /пробн|знаком|бесплатн|вводн|первичн/.test(normalized);
  const freeServiceIds = new Set(config.prices.filter((price) => price.amount === 0).map((price) => price.serviceId));
  const introService =
    config.services.find((service) => freeServiceIds.has(service.id)) ??
    config.services.find((service) => /intro|знаком|пробн|бесплатн|первичн/i.test(`${service.id} ${service.title} ${service.description}`));
  const durationService = config.services.find((service) => service.durationMinutes === durationMinutes);
  const consultationService =
    config.services.find((service) => /consult|консультац/i.test(`${service.id} ${service.title}`)) ?? config.services.find((service) => !freeServiceIds.has(service.id));
  if (introRequested || !hasPreviousSessions) return introService?.id ?? durationService?.id;
  return durationService?.id ?? consultationService?.id ?? introService?.id;
}

function serviceTitle(config: BotConfig | undefined, serviceId: string | undefined, durationMinutes?: number): string {
  const service =
    (serviceId ? config?.services.find((item) => item.id === serviceId) : undefined) ??
    (durationMinutes ? config?.services.find((item) => item.durationMinutes === durationMinutes) : undefined);
  return service?.title || serviceId || "Консультация";
}

function clientHasSessions(client: ClientSummary): boolean {
  return Boolean(client.agentProfile.sessionHistory.length || client.manualProfile.sessionHistory.length);
}

function extractProfileFact(text: string): string | undefined {
  const cleaned = text
    .replace(/^(?:запомни|сохрани|добавь\s+(?:в\s+)?(?:профиль|карточку|память)|внеси\s+(?:в\s+)?(?:профиль|карточку|память))[:,\s]*/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 3 ? cleaned.slice(0, 500) : undefined;
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

function formatPendingAction(action: PendingAction, config?: BotConfig): string {
  const lines = [`Понял задачу: ${safe(actionTitle(action.kind))}.`];
  if (action.kind === "reminder_create") {
    const reminderDueAt = normalizeDueAt(action.fields.dueAt, repeatField(action.fields.repeat)) || stringField(action.fields.dueAt) || "";
    const medicationName = medicationField(action.fields.medicationName);
    const reminderKind = stringField(action.fields.reminderKind);
    lines.push("", "Что будет сделано:");
    lines.push(`Тип: ${medicationName || reminderKind === "medication" ? "напоминание о препарате" : "обычное напоминание"}`);
    if (medicationName) lines.push(`Препарат: ${safe(medicationName)}`);
    lines.push(`Текст: ${safe(normalizeReminderText(stringField(action.fields.text) || "") || "не указан")}`);
    lines.push(`Повтор: ${safe(repeatLabel(repeatField(action.fields.repeat)))}`);
    lines.push(`Первый раз: ${safe(humanDateTime(reminderDueAt)) || "не указано"}`);
    lines.push("Проверка выполнения: после напоминания буду ждать подтверждение; без подтверждения повторю через 5 минут.");
  } else if (action.kind === "booking_create") {
    lines.push("", "Что будет сделано:");
    lines.push(`Дата и время: ${safe(humanDateTime(bookingStartsAt(action.fields) || "") || "не указано")}`);
    lines.push(`Длительность: ${numberField(action.fields.durationMinutes) || "не указана"} минут`);
    const serviceId = stringField(action.fields.serviceId);
    if (serviceId) lines.push(`Услуга: ${safe(serviceTitle(config, serviceId, numberField(action.fields.durationMinutes)))}`);
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

function todayDateKey(_timezone = "Europe/Moscow"): string {
  return dateKey(new Date().toISOString());
}

function nextWeekdayDateKey(today: string, weekdayIndex: number): string {
  const todayIndex = new Date(`${today}T12:00:00+03:00`).getUTCDay();
  const delta = (weekdayIndex - todayIndex + 7) % 7;
  return addDays(today, delta);
}

function dateKeyFromParts(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${candidate}T12:00:00+03:00`);
  return dateKey(parsed.toISOString()) === candidate ? candidate : undefined;
}

function hhmm(hour: string, minute: string): string {
  return `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute || "0")).padStart(2, "0")}`;
}

function clampDuration(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 5 || value > 240) return undefined;
  return Math.round(value);
}

function normalizeRu(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е");
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
