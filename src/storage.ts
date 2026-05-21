import { DEFAULT_CONFIG, DEFAULT_SLOTS } from "./defaults";
import { appStateStub } from "./memory";
import type { BotConfig, CalendarSlot, ClientSummary, Env, TranscriptMessage } from "./types";

const CONFIG_KEY = "config/bot.json";
const SLOTS_KEY = "calendar/slots.json";
const USERS_KEY = "users/index.json";

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

export function readSlots(env: Env): Promise<CalendarSlot[]> {
  return readStoredJson(env, SLOTS_KEY, DEFAULT_SLOTS);
}

export function writeSlots(env: Env, slots: CalendarSlot[]): Promise<void> {
  return writeStoredJson(env, SLOTS_KEY, slots);
}

export async function readUsers(env: Env): Promise<ClientSummary[]> {
  const users = await readStoredJson<ClientSummary[]>(env, USERS_KEY, []);
  return users.sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

export async function writeUsers(env: Env, users: ClientSummary[]): Promise<void> {
  await writeStoredJson(env, USERS_KEY, users);
}

export async function upsertClient(env: Env, patch: Partial<ClientSummary> & { chatId: string }): Promise<ClientSummary> {
  const users = await readStoredJson<ClientSummary[]>(env, USERS_KEY, []);
  const index = users.findIndex((user) => user.chatId === patch.chatId);
  const current: ClientSummary =
    index >= 0
      ? users[index]
      : {
          chatId: patch.chatId,
          lastMessageAt: new Date().toISOString(),
          messageCount: 0,
          tags: [],
          facts: [],
          reminders: [],
          riskLevel: "none"
        };
  const next: ClientSummary = {
    ...current,
    ...patch,
    tags: mergeUnique(current.tags, patch.tags),
    facts: mergeUnique(current.facts, patch.facts),
    reminders: mergeUnique(current.reminders, patch.reminders),
    messageCount: patch.messageCount ?? current.messageCount
  };
  if (index >= 0) users[index] = next;
  else users.push(next);
  await writeStoredJson(env, USERS_KEY, users);
  return next;
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
      };
      const createdAt = record.createdAt ?? new Date(0).toISOString();
      if (record.role && record.text) {
        messages.push({ role: record.role, text: record.text, createdAt, source: record.source });
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

function mergeUnique(current: string[] | undefined, patch: string[] | undefined): string[] {
  const values = [...(current ?? []), ...(patch ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, 24);
}
