import { DEFAULT_CONFIG, DEFAULT_SCHEDULE } from "./defaults";
import { appStateStub } from "./memory";
import type {
  Booking,
  BotConfig,
  ClientProfileData,
  ClientReminder,
  ClientRiskLevel,
  ClientSummary,
  ConsentRecord,
  Env,
  GoogleBusyEvent,
  LegacyCalendarSlot,
  SiteArticle,
  SiteConfig,
  SiteLinkToken,
  SiteRateBucket,
  SiteSession,
  SiteTranscriptMessage,
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
const SITE_CONFIG_KEY = "site/config.json";
const SITE_ARTICLES_KEY = "site/articles/index.json";
const SITE_CONSENTS_KEY = "site/consents/index.json";
const SITE_SESSIONS_PREFIX = "site/sessions";
const SITE_LINK_TOKENS_PREFIX = "site/link_tokens";
const SITE_RATE_PREFIX = "site/rate";
const SITE_TRANSCRIPT_RETENTION_MESSAGES = 200;

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  enabled: true,
  webBotEnabled: true,
  brandName: "НейроПсихолог",
  headline: "Психологические консультации для нейроотличных взрослых",
  subheadline: "РАС, СДВГ, перегрузки, адаптация и коммуникация. Спокойно, структурно, без эзотерики.",
  bio:
    "Онлайн-консультации для взрослых людей с РАС, СДВГ, смешанной нейроотличностью или подозрением на нее. Бот помогает с первичной навигацией и записью, психолог отвечает вручную, когда нужен личный контакт.",
  telegramUrl: "https://t.me/practicing_autist_bot",
  githubUrl: "https://github.com/TryDotAtwo/psychologist-telegram-agent",
  consentVersion: "2026-06-20",
  consentText:
    "Я понимаю, что при обращении через сайт или бота могут обрабатываться мои сообщения, контактные данные, сведения о запросе, записи, напоминаниях и факты, которые я сам(а) сообщаю. Я понимаю, что бот не ставит диагноз, не является экстренной помощью и не заменяет врача.",
  privacyText:
    "Сайт и Telegram-бот обрабатывают данные только для ответа на запрос, записи на консультацию, ведения диалога, напоминаний и улучшения непрерывности сопровождения. Хранятся сообщения, техническая site-сессия, согласие, выбранные окна записи, клиентский профиль и служебные логи. Данные не публикуются и не передаются в публичный блог. Исходный код доступен на GitHub.",
  articleAgentInstructions:
    "Пиши статьи для взрослых нейроотличных людей спокойным русским языком. Не ставь диагнозы, не обещай лечение, не используй эзотерику и маркетинговые клише. Объясняй, где заканчивается самонаблюдение и начинается необходимость очной помощи.",
  turnstileSiteKey: undefined
};

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

export async function readSiteConfig(env: Env): Promise<SiteConfig> {
  const stored = await readStoredJson<Partial<SiteConfig>>(env, SITE_CONFIG_KEY, {});
  return normalizeSiteConfig({
    ...DEFAULT_SITE_CONFIG,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || DEFAULT_SITE_CONFIG.turnstileSiteKey,
    ...stored
  });
}

export function writeSiteConfig(env: Env, config: SiteConfig): Promise<void> {
  return writeStoredJson(env, SITE_CONFIG_KEY, normalizeSiteConfig(config));
}

export async function readSiteArticles(env: Env): Promise<SiteArticle[]> {
  const articles = await readStoredJson<SiteArticle[]>(env, SITE_ARTICLES_KEY, []);
  return articles.map(normalizeSiteArticle).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function writeSiteArticles(env: Env, articles: SiteArticle[]): Promise<void> {
  return writeStoredJson(env, SITE_ARTICLES_KEY, articles.map(normalizeSiteArticle));
}

export async function upsertSiteArticle(env: Env, article: SiteArticle): Promise<SiteArticle> {
  const articles = await readSiteArticles(env);
  const normalized = normalizeSiteArticle(article);
  const index = articles.findIndex((item) => item.id === normalized.id);
  if (index >= 0) articles[index] = normalized;
  else articles.push(normalized);
  await writeSiteArticles(env, articles);
  return normalized;
}

export function readSiteSession(env: Env, id: string): Promise<SiteSession | null> {
  return readStoredJson<SiteSession | null>(env, siteSessionKey(id), null);
}

export function writeSiteSession(env: Env, session: SiteSession): Promise<void> {
  return writeStoredJson(env, siteSessionKey(session.id), session);
}

export async function readConsentRecords(env: Env): Promise<ConsentRecord[]> {
  return readStoredJson<ConsentRecord[]>(env, SITE_CONSENTS_KEY, []);
}

export async function appendConsentRecord(env: Env, record: ConsentRecord): Promise<void> {
  const records = await readConsentRecords(env);
  records.push(record);
  await writeStoredJson(env, SITE_CONSENTS_KEY, records.slice(-1000));
}

export function readSiteLinkToken(env: Env, tokenHash: string): Promise<SiteLinkToken | null> {
  return readStoredJson<SiteLinkToken | null>(env, siteLinkTokenKey(tokenHash), null);
}

export function writeSiteLinkToken(env: Env, token: SiteLinkToken): Promise<void> {
  return writeStoredJson(env, siteLinkTokenKey(token.tokenHash), token);
}

export function readSiteRateBucket(env: Env, key: string): Promise<SiteRateBucket | null> {
  return readStoredJson<SiteRateBucket | null>(env, `${SITE_RATE_PREFIX}/${safeStoragePart(key)}.json`, null);
}

export function writeSiteRateBucket(env: Env, bucket: SiteRateBucket): Promise<void> {
  return writeStoredJson(env, `${SITE_RATE_PREFIX}/${safeStoragePart(bucket.key)}.json`, bucket);
}

export async function readSiteTranscript(env: Env, siteSessionId: string): Promise<SiteTranscriptMessage[]> {
  const text = await readStoredText(env, `${SITE_SESSIONS_PREFIX}/${safeStoragePart(siteSessionId)}/transcript.jsonl`, "");
  const messages: SiteTranscriptMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as SiteTranscriptMessage;
      if ((record.role === "user" || record.role === "assistant") && record.text && record.createdAt) messages.push(record);
    } catch {
      messages.push({ role: "assistant", text: trimmed, createdAt: new Date(0).toISOString(), source: "bot" });
    }
  }
  return messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export async function appendSiteTranscriptMessage(env: Env, siteSessionId: string, message: SiteTranscriptMessage): Promise<void> {
  const messages = [...(await readSiteTranscript(env, siteSessionId)), message]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-SITE_TRANSCRIPT_RETENTION_MESSAGES);
  const text = messages.map((item) => JSON.stringify(item)).join("\n");
  await writeStoredText(env, `${SITE_SESSIONS_PREFIX}/${safeStoragePart(siteSessionId)}/transcript.jsonl`, text ? `${text}\n` : "", "application/x-ndjson; charset=utf-8");
}

export async function writeSiteAsset(env: Env, key: string, value: Blob | ArrayBuffer | string, contentType: string): Promise<void> {
  await writeStoredBlob(env, key, value, contentType);
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

export async function writeStoredBlob(env: Env, key: string, value: Blob | ArrayBuffer | string, contentType = "application/octet-stream"): Promise<void> {
  if (env.BOT_OBJECTS) {
    await env.BOT_OBJECTS.put(key, value, { httpMetadata: { contentType } });
    return;
  }
  if (typeof value === "string") return writeStoredText(env, key, value, contentType);
  const bytes = value instanceof Blob ? await value.arrayBuffer() : value;
  const encoded = arrayBufferToBase64(bytes);
  await appStateStub(env).fetch(`https://app-state/kv?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ contentType, base64: encoded })
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

function normalizeSiteConfig(config: SiteConfig): SiteConfig {
  return {
    enabled: config.enabled !== false,
    webBotEnabled: config.webBotEnabled !== false,
    brandName: String(config.brandName || DEFAULT_SITE_CONFIG.brandName).slice(0, 120),
    headline: String(config.headline || DEFAULT_SITE_CONFIG.headline).slice(0, 240),
    subheadline: String(config.subheadline || DEFAULT_SITE_CONFIG.subheadline).slice(0, 500),
    bio: String(config.bio || DEFAULT_SITE_CONFIG.bio).slice(0, 2500),
    telegramUrl: String(config.telegramUrl || DEFAULT_SITE_CONFIG.telegramUrl).slice(0, 300),
    githubUrl: String(config.githubUrl || DEFAULT_SITE_CONFIG.githubUrl).slice(0, 300),
    consentVersion: String(config.consentVersion || DEFAULT_SITE_CONFIG.consentVersion).slice(0, 80),
    consentText: String(config.consentText || DEFAULT_SITE_CONFIG.consentText).slice(0, 4000),
    privacyText: String(config.privacyText || DEFAULT_SITE_CONFIG.privacyText).slice(0, 8000),
    articleAgentInstructions: String(config.articleAgentInstructions || DEFAULT_SITE_CONFIG.articleAgentInstructions).slice(0, 4000),
    turnstileSiteKey: config.turnstileSiteKey ? String(config.turnstileSiteKey).slice(0, 200) : undefined
  };
}

function normalizeSiteArticle(article: SiteArticle): SiteArticle {
  const now = new Date().toISOString();
  return {
    id: article.id || `article_${crypto.randomUUID()}`,
    slug: safeSlug(article.slug || article.title || "article"),
    title: String(article.title || "Без названия").slice(0, 180),
    summary: String(article.summary || "").slice(0, 500),
    bodyMarkdown: String(article.bodyMarkdown || "").slice(0, 40_000),
    status: article.status === "published" || article.status === "archived" ? article.status : "draft",
    tags: normalizeList(article.tags).slice(0, 12),
    coverImageKey: article.coverImageKey,
    coverImageUrl: article.coverImageUrl,
    seoTitle: article.seoTitle ? String(article.seoTitle).slice(0, 180) : undefined,
    seoDescription: article.seoDescription ? String(article.seoDescription).slice(0, 300) : undefined,
    createdAt: article.createdAt || now,
    updatedAt: article.updatedAt || now,
    publishedAt: article.publishedAt
  };
}

function siteSessionKey(id: string): string {
  return `${SITE_SESSIONS_PREFIX}/${safeStoragePart(id)}/session.json`;
}

function siteLinkTokenKey(tokenHash: string): string {
  return `${SITE_LINK_TOKENS_PREFIX}/${safeStoragePart(tokenHash)}.json`;
}

function safeStoragePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s_-]/gi, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120) || `article-${Date.now()}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
