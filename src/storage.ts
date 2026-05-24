import { DEFAULT_CONFIG, DEFAULT_SCHEDULE } from "./defaults";
import { appStateStub } from "./memory";
import type {
  Booking,
  BotConfig,
  ClientProfileData,
  ClientReminder,
  ClientRiskLevel,
  ClientSummary,
  Env,
  GoogleBusyEvent,
  LegacyCalendarSlot,
  TranscriptMessage,
  WorkSchedule
} from "./types";

const CONFIG_KEY = "config/bot.json";
const LEGACY_SLOTS_KEY = "calendar/slots.json";
const SCHEDULE_KEY = "calendar/work_schedule.json";
const BOOKINGS_KEY = "calendar/bookings.json";
const GOOGLE_BUSY_KEY = "calendar/google_busy.json";
const USERS_KEY = "users/index.json";
const REMINDERS_KEY = "reminders/index.json";
const TRANSCRIPT_RETENTION_MESSAGES = 500;

export const EMPTY_PROFILE: ClientProfileData = {
  facts: [],
  medications: [],
  doctors: [],
  appointments: [],
  problems: [],
  preferences: [],
  riskNotes: [],
  reminders: [],
  psychologistNotes: [],
  sessionHistory: []
};

export async function readJson<T>(bucket: R2Bucket, key: string, fallback: T): Promise<T> {
  const object = await bucket.get(key);
  if (!object) return fallback;
  return (await object.json()) as T;
}

export async function writeJson<T>(bucket: R2Bucket, key: string, value: T): Promise<void> {
  await bucket.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

export function readConfig(env: Env): Promise<BotConfig> {
  return readStoredJson(env, CONFIG_KEY, DEFAULT_CONFIG);
}

export function writeConfig(env: Env, config: BotConfig): Promise<void> {
  return writeStoredJson(env, CONFIG_KEY, config);
}

export async function readSchedule(env: Env): Promise<WorkSchedule> {
  const schedule = await readStoredJson<WorkSchedule>(env, SCHEDULE_KEY, { ...DEFAULT_SCHEDULE, timezone: env.TIMEZONE || DEFAULT_SCHEDULE.timezone });
  return {
    ...DEFAULT_SCHEDULE,
    ...schedule,
    timezone: schedule.timezone || env.TIMEZONE || DEFAULT_SCHEDULE.timezone,
    weeklyTemplate: { ...DEFAULT_SCHEDULE.weeklyTemplate, ...(schedule.weeklyTemplate ?? {}) },
    dateOverrides: schedule.dateOverrides ?? {}
  };
}

export function writeSchedule(env: Env, schedule: WorkSchedule): Promise<void> {
  return writeStoredJson(env, SCHEDULE_KEY, schedule);
}

export async function readBookings(env: Env): Promise<Booking[]> {
  const bookings = await readStoredJson<Booking[]>(env, BOOKINGS_KEY, []);
  return bookings.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function writeBookings(env: Env, bookings: Booking[]): Promise<void> {
  return writeStoredJson(env, BOOKINGS_KEY, bookings);
}

export function readGoogleBusy(env: Env): Promise<GoogleBusyEvent[]> {
  return readStoredJson(env, GOOGLE_BUSY_KEY, []);
}

export function writeGoogleBusy(env: Env, busy: GoogleBusyEvent[]): Promise<void> {
  return writeStoredJson(env, GOOGLE_BUSY_KEY, busy);
}

export async function readLegacySlots(env: Env): Promise<LegacyCalendarSlot[]> {
  return readStoredJson<LegacyCalendarSlot[]>(env, LEGACY_SLOTS_KEY, []);
}

export async function readUsers(env: Env): Promise<ClientSummary[]> {
  const users = await readStoredJson<ClientSummary[]>(env, USERS_KEY, []);
  return users.map(normalizeClient).sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

export async function writeUsers(env: Env, users: ClientSummary[]): Promise<void> {
  await writeStoredJson(env, USERS_KEY, users.map(normalizeClient));
}

export async function upsertClient(
  env: Env,
  patch: Omit<Partial<ClientSummary>, "agentProfile" | "manualProfile"> & {
    chatId: string;
    agentProfile?: Partial<ClientProfileData>;
    manualProfile?: Partial<ClientProfileData>;
  }
): Promise<ClientSummary> {
  const users = await readStoredJson<ClientSummary[]>(env, USERS_KEY, []);
  const normalized = users.map(normalizeClient);
  const index = normalized.findIndex((user) => user.chatId === patch.chatId);
  const current =
    index >= 0
      ? normalized[index]
      : normalizeClient({
          chatId: patch.chatId,
          lastMessageAt: new Date().toISOString(),
          messageCount: 0,
          tags: [],
          facts: [],
          reminders: [],
          riskLevel: "none"
        });
  const next: ClientSummary = normalizeClient({
    ...current,
    ...patch,
    tags: mergeUnique(current.tags, patch.tags),
    facts: mergeUnique(current.facts, patch.facts),
    reminders: mergeUnique(current.reminders, patch.reminders),
    messageCount: patch.messageCount ?? current.messageCount,
    riskLevel: mergeRisk(current.riskLevel, patch.riskLevel),
    agentProfile: mergeProfile(current.agentProfile, patch.agentProfile),
    manualProfile: mergeProfile(current.manualProfile, patch.manualProfile)
  } as ClientSummary);
  if (index >= 0) normalized[index] = next;
  else normalized.push(next);
  await writeStoredJson(env, USERS_KEY, normalized);
  return next;
}

export function normalizeClient(user: Partial<ClientSummary> & { chatId: string }): ClientSummary {
  const agentProfile = normalizeProfile(user.agentProfile, {
    facts: user.facts ?? [],
    reminders: user.reminders ?? []
  });
  const manualProfile = normalizeProfile(user.manualProfile);
  return {
    chatId: user.chatId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    lastMessageAt: user.lastMessageAt ?? new Date().toISOString(),
    lastUserText: user.lastUserText,
    lastAssistantText: user.lastAssistantText,
    messageCount: user.messageCount ?? 0,
    tags: normalizeList(user.tags),
    facts: mergeUnique(agentProfile.facts, manualProfile.facts),
    reminders: mergeUnique(agentProfile.reminders, manualProfile.reminders),
    riskLevel: user.riskLevel ?? "none",
    nextAction: user.nextAction,
    attentionAt: user.attentionAt || undefined,
    attentionReason:
      user.attentionReason === "client_requested_psychologist" || user.attentionReason === "manual_dialog_active" ? user.attentionReason : undefined,
    botPausedUntil: user.botPausedUntil || undefined,
    botPausedReason: user.botPausedReason || undefined,
    botPausedBy: user.botPausedBy === "admin" || user.botPausedBy === "manual" ? user.botPausedBy : undefined,
    lastAdminReplyAt: user.lastAdminReplyAt || undefined,
    lastProfiledAt: user.lastProfiledAt || undefined,
    lastProfiledMessageCount: typeof user.lastProfiledMessageCount === "number" ? user.lastProfiledMessageCount : undefined,
    longTermMemoryUpdatedAt: user.longTermMemoryUpdatedAt || undefined,
    memorySummary: user.memorySummary || undefined,
    pendingAction: normalizePendingAction(user.pendingAction),
    agentProfile,
    manualProfile
  };
}

export function normalizeProfile(profile?: Partial<ClientProfileData>, seeds?: Partial<ClientProfileData>): ClientProfileData {
  return {
    facts: normalizeList([...(seeds?.facts ?? []), ...(profile?.facts ?? [])]),
    medications: normalizeList([...(seeds?.medications ?? []), ...(profile?.medications ?? [])]),
    doctors: normalizeList([...(seeds?.doctors ?? []), ...(profile?.doctors ?? [])]),
    appointments: normalizeList([...(seeds?.appointments ?? []), ...(profile?.appointments ?? [])]),
    problems: normalizeList([...(seeds?.problems ?? []), ...(profile?.problems ?? [])]),
    preferences: normalizeList([...(seeds?.preferences ?? []), ...(profile?.preferences ?? [])]),
    riskNotes: normalizeList([...(seeds?.riskNotes ?? []), ...(profile?.riskNotes ?? [])]),
    reminders: normalizeList([...(seeds?.reminders ?? []), ...(profile?.reminders ?? [])]),
    psychologistNotes: normalizeList([...(seeds?.psychologistNotes ?? []), ...(profile?.psychologistNotes ?? [])]),
    sessionHistory: [...(seeds?.sessionHistory ?? []), ...(profile?.sessionHistory ?? [])].slice(-40),
    modalDurationMinutes: profile?.modalDurationMinutes ?? seeds?.modalDurationMinutes
  };
}

export function mergeProfile(current?: Partial<ClientProfileData>, patch?: Partial<ClientProfileData>): ClientProfileData {
  const base = normalizeProfile(current);
  if (!patch) return base;
  return {
    facts: mergeUnique(base.facts, patch.facts),
    medications: mergeUnique(base.medications, patch.medications),
    doctors: mergeUnique(base.doctors, patch.doctors),
    appointments: mergeUnique(base.appointments, patch.appointments),
    problems: mergeUnique(base.problems, patch.problems),
    preferences: mergeUnique(base.preferences, patch.preferences),
    riskNotes: mergeUnique(base.riskNotes, patch.riskNotes),
    reminders: mergeUnique(base.reminders, patch.reminders),
    psychologistNotes: mergeUnique(base.psychologistNotes, patch.psychologistNotes),
    sessionHistory: [...base.sessionHistory, ...(patch.sessionHistory ?? [])].slice(-40),
    modalDurationMinutes: patch.modalDurationMinutes ?? base.modalDurationMinutes
  };
}

export async function readReminders(env: Env): Promise<ClientReminder[]> {
  const reminders = await readStoredJson<ClientReminder[]>(env, REMINDERS_KEY, []);
  return reminders.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export function writeReminders(env: Env, reminders: ClientReminder[]): Promise<void> {
  return writeStoredJson(env, REMINDERS_KEY, reminders);
}

export async function upsertReminder(env: Env, reminder: ClientReminder): Promise<ClientReminder> {
  const reminders = await readReminders(env);
  const index = reminders.findIndex((item) => item.id === reminder.id);
  if (index >= 0) reminders[index] = reminder;
  else reminders.push(reminder);
  await writeReminders(env, reminders);
  return reminder;
}

export async function readTranscript(env: Env, chatId: string): Promise<TranscriptMessage[]> {
  const text = await readStoredText(env, `transcripts/${chatId}.jsonl`, "");
  const messages: TranscriptMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as {
        role?: "user" | "assistant";
        text?: string;
        user?: string;
        assistant?: string;
        createdAt?: string;
        source?: "bot" | "admin" | "telegram";
        attachments?: TranscriptMessage["attachments"];
      };
      const createdAt = record.createdAt ?? new Date(0).toISOString();
      if (record.role && record.text) {
        messages.push({ role: record.role, text: record.text, createdAt, source: record.source, attachments: record.attachments });
        continue;
      }
      if (record.user) messages.push({ role: "user", text: record.user, createdAt, source: "telegram" });
      if (record.assistant) messages.push({ role: "assistant", text: record.assistant, createdAt, source: record.source ?? "bot" });
    } catch {
      messages.push({ role: "assistant", text: trimmed, createdAt: new Date(0).toISOString(), source: "bot" });
    }
  }
  return messages;
}

export async function appendTranscriptMessage(env: Env, chatId: string, message: TranscriptMessage): Promise<void> {
  const messages = [...(await readTranscript(env, chatId)), message]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-TRANSCRIPT_RETENTION_MESSAGES);
  const text = messages.map((item) => JSON.stringify(item)).join("\n");
  await writeStoredText(env, `transcripts/${chatId}.jsonl`, text ? `${text}\n` : "", "application/x-ndjson; charset=utf-8");
}

export async function appendJsonl(bucket: R2Bucket, key: string, record: unknown): Promise<void> {
  const existing = await bucket.get(key);
  const current = existing ? await existing.text() : "";
  await bucket.put(key, `${current}${JSON.stringify(record)}\n`, {
    httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" }
  });
}

export async function appendStoredJsonl(env: Env, key: string, record: unknown): Promise<void> {
  if (env.BOT_OBJECTS) {
    await appendJsonl(env.BOT_OBJECTS, key, record);
    return;
  }
  await appStateStub(env).fetch(`https://app-state/append-jsonl?key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: JSON.stringify(record)
  });
}

export async function readStoredJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  if (env.BOT_OBJECTS) return readJson(env.BOT_OBJECTS, key, fallback);
  const response = await appStateStub(env).fetch(`https://app-state/kv?key=${encodeURIComponent(key)}`);
  if (!response.ok) return fallback;
  const data = (await response.json()) as { found: boolean; value?: T };
  return data.found ? (data.value as T) : fallback;
}

export async function readStoredText(env: Env, key: string, fallback = ""): Promise<string> {
  if (env.BOT_OBJECTS) {
    const object = await env.BOT_OBJECTS.get(key);
    return object ? object.text() : fallback;
  }
  const response = await appStateStub(env).fetch(`https://app-state/kv?key=${encodeURIComponent(key)}`);
  if (!response.ok) return fallback;
  const data = (await response.json()) as { found: boolean; value?: unknown };
  return data.found && typeof data.value === "string" ? data.value : fallback;
}

export async function writeStoredText(env: Env, key: string, value: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
  if (env.BOT_OBJECTS) {
    await env.BOT_OBJECTS.put(key, value, { httpMetadata: { contentType } });
    return;
  }
  await appStateStub(env).fetch(`https://app-state/kv?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(value)
  });
}

export async function appendStoredText(env: Env, key: string, value: string, contentType = "text/markdown; charset=utf-8"): Promise<void> {
  const current = await readStoredText(env, key, "");
  await writeStoredText(env, key, `${current}${value}`, contentType);
}

export async function writeStoredJson<T>(env: Env, key: string, value: T): Promise<void> {
  if (env.BOT_OBJECTS) {
    await writeJson(env.BOT_OBJECTS, key, value);
    return;
  }
  await appStateStub(env).fetch(`https://app-state/kv?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(value)
  });
}

export function mergedProfile(user: ClientSummary): ClientProfileData {
  return mergeProfile(user.agentProfile, user.manualProfile);
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 60);
}

function mergeUnique(current: string[] | undefined, patch: string[] | undefined): string[] {
  return normalizeList([...(current ?? []), ...(patch ?? [])]);
}

function mergeRisk(current: ClientRiskLevel | undefined, next: ClientRiskLevel | undefined): ClientRiskLevel {
  if (current === "urgent" || next === "urgent") return "urgent";
  if (current === "watch" || next === "watch") return "watch";
  return "none";
}

function normalizePendingAction(action: ClientSummary["pendingAction"]): ClientSummary["pendingAction"] {
  if (!action) return undefined;
  if (action.kind !== "reminder_create" && action.kind !== "booking_create" && action.kind !== "profile_update") return undefined;
  return {
    id: action.id || `pending_${crypto.randomUUID()}`,
    kind: action.kind,
    summary: action.summary || "",
    fields: action.fields && typeof action.fields === "object" ? action.fields : {},
    missingFields: normalizeList(action.missingFields),
    originalText: action.originalText || "",
    createdAt: action.createdAt || new Date().toISOString(),
    updatedAt: action.updatedAt || new Date().toISOString()
  };
}
