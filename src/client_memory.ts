import { extractClientProfilePatch } from "./openai";
import {
  appendStoredJsonl,
  appendStoredText,
  mergedProfile,
  readStoredJson,
  readStoredText,
  readTranscript,
  readUsers,
  upsertClient,
  writeStoredJson,
  writeStoredText
} from "./storage";
import type { BotConfig, ClientSummary, Env, TranscriptMessage } from "./types";

type DurableConversationContext = {
  profile: unknown;
  turns: { role: string; text: string; createdAt: string }[];
};

export type ClientConversationContext = DurableConversationContext & {
  longTermMemory: string;
  recentJournal: string;
  memoryBudget: {
    maxTokens: number;
    estimatedTokens: number;
    longTermChars: number;
    recentJournalChars: number;
    recentTurns: number;
  };
};

type ClientMemoryState = {
  chatId: string;
  lastProfiledAt?: string;
  lastProfiledMessageCount?: number;
  longTermMemoryUpdatedAt?: string;
  journalUpdatedAt?: string;
};

type ClientMemoryTurn = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  source: "bot" | "admin" | "telegram";
};

const PROFILE_EVERY_MESSAGES = 50;
const MAX_CONTEXT_TOKENS = 64_000;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * 4;
const MAX_LONG_TERM_CHARS = 120_000;
const MAX_RECENT_JOURNAL_CHARS = 80_000;
const MAX_PROFILE_BATCH_MESSAGES = 120;

export function shouldRefreshClientMemoryProfile(client: ClientSummary): boolean {
  const count = client.messageCount || 0;
  if (count < PROFILE_EVERY_MESSAGES) return false;
  if (count % PROFILE_EVERY_MESSAGES !== 0) return false;
  return (client.lastProfiledMessageCount || 0) < count;
}

export async function appendClientMemoryMarkdown(env: Env, chatId: string, turn: ClientMemoryTurn): Promise<void> {
  const safeText = turn.text.trim().slice(0, 8000);
  if (!safeText) return;
  await appendStoredText(env, memoryJournalKey(chatId), `\n## ${turn.createdAt} ${turn.role} (${turn.source})\n\n${safeText}\n`);
  await writeMemoryState(env, chatId, { journalUpdatedAt: turn.createdAt });
}

export async function buildClientConversationContext(
  env: Env,
  chatId: string,
  client: ClientSummary,
  durableContext: DurableConversationContext
): Promise<ClientConversationContext> {
  const [longTermMemoryRaw, journalRaw] = await Promise.all([
    readStoredText(env, longTermMemoryKey(chatId), ""),
    readStoredText(env, memoryJournalKey(chatId), "")
  ]);
  const profile = mergedProfile(client);
  const turns = durableContext.turns.slice(-40);
  const baseContextChars = JSON.stringify({ profile, turns }).length;
  const longTermBudget = Math.max(0, Math.min(MAX_LONG_TERM_CHARS, MAX_CONTEXT_CHARS - baseContextChars - 20_000));
  const longTermMemory = tail(longTermMemoryRaw, longTermBudget);
  const recentBudget = Math.max(0, Math.min(MAX_RECENT_JOURNAL_CHARS, MAX_CONTEXT_CHARS - baseContextChars - longTermMemory.length - 8_000));
  const recentJournal = tail(journalRaw, recentBudget);
  const estimatedTokens = Math.ceil((baseContextChars + longTermMemory.length + recentJournal.length) / 4);
  return {
    ...durableContext,
    profile,
    turns,
    longTermMemory,
    recentJournal,
    memoryBudget: {
      maxTokens: MAX_CONTEXT_TOKENS,
      estimatedTokens,
      longTermChars: longTermMemory.length,
      recentJournalChars: recentJournal.length,
      recentTurns: turns.length
    }
  };
}

export async function refreshClientMemoryProfile(env: Env, config: BotConfig, chatId: string, reason: "auto_50_messages" | "manual_dashboard"): Promise<ClientSummary | null> {
  const users = await readUsers(env);
  const client = users.find((item) => item.chatId === chatId);
  if (!client) return null;
  const transcript = await readTranscript(env, chatId);
  const batch = transcript.slice(-MAX_PROFILE_BATCH_MESSAGES);
  const batchText = renderTranscriptBatch(batch);
  const context: DurableConversationContext = {
    profile: mergedProfile(client),
    turns: batch.slice(-40).map((message) => ({ role: message.role, text: message.text, createdAt: message.createdAt }))
  };
  let updated = client;
  try {
    const extraction = await extractClientProfilePatch(env, config, batchText, context);
    if (extraction) {
      updated = await upsertClient(env, {
        chatId,
        tags: extraction.tags,
        agentProfile: extraction.profile,
        riskLevel: mergeRisk(client.riskLevel, extraction.riskLevel),
        nextAction: extraction.nextAction || client.nextAction
      });
    }
  } catch (error) {
    await appendStoredJsonl(env, "logs/profile_extract_errors.jsonl", {
      chatId,
      reason,
      message: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString()
    });
  }

  const now = new Date().toISOString();
  const finalClient = await upsertClient(env, {
    chatId,
    lastProfiledAt: now,
    lastProfiledMessageCount: updated.messageCount,
    longTermMemoryUpdatedAt: now,
    memorySummary: memorySummary(updated)
  });
  await writeStoredText(env, longTermMemoryKey(chatId), renderLongTermMemory(finalClient, batch, reason, now), "text/markdown; charset=utf-8");
  await writeMemoryState(env, chatId, {
    lastProfiledAt: now,
    lastProfiledMessageCount: finalClient.messageCount,
    longTermMemoryUpdatedAt: now
  });
  await appendStoredJsonl(env, "logs/client_memory_profile_runs.jsonl", {
    chatId,
    reason,
    messageCount: finalClient.messageCount,
    batchMessages: batch.length,
    createdAt: now
  });
  return { ...finalClient, mergedProfile: mergedProfile(finalClient) } as ClientSummary;
}

function renderTranscriptBatch(messages: TranscriptMessage[]): string {
  return messages.map((message) => `[${message.createdAt}] ${message.role}/${message.source ?? message.role}: ${message.text}`).join("\n").slice(-60_000);
}

function renderLongTermMemory(client: ClientSummary, messages: TranscriptMessage[], reason: string, updatedAt: string): string {
  const profile = mergedProfile(client);
  const sections = [
    "# Client long-term memory",
    `chatId=${client.chatId}`,
    `updatedAt=${updatedAt}`,
    `reason=${reason}`,
    `messageCount=${client.messageCount}`,
    "",
    "## Stable profile",
    listSection("Facts", profile.facts),
    listSection("Medications reported by client", profile.medications),
    listSection("Doctors reported by client", profile.doctors),
    listSection("Appointments", profile.appointments),
    listSection("Problems", profile.problems),
    listSection("Preferences", profile.preferences),
    listSection("Risk notes", profile.riskNotes),
    listSection("Psychologist notes", profile.psychologistNotes),
    "",
    "## Current work state",
    `riskLevel=${client.riskLevel}`,
    `nextAction=${client.nextAction || "none"}`,
    `memorySummary=${memorySummary(client)}`,
    "",
    "## Recent compacted dialogue",
    ...messages.slice(-40).map((message) => `- ${message.createdAt}; ${message.role}; ${message.source ?? message.role}; ${oneLine(message.text, 500)}`)
  ];
  return `${sections.join("\n").slice(0, MAX_LONG_TERM_CHARS)}\n`;
}

function listSection(title: string, values: string[]): string {
  return [`### ${title}`, ...(values.length ? values.map((value) => `- ${oneLine(value, 500)}`) : ["- none"])].join("\n");
}

async function writeMemoryState(env: Env, chatId: string, patch: Partial<ClientMemoryState>): Promise<void> {
  const current = await readStoredJson<ClientMemoryState>(env, memoryStateKey(chatId), { chatId });
  await writeStoredJson(env, memoryStateKey(chatId), { ...current, ...patch, chatId });
}

function memorySummary(client: ClientSummary): string {
  const profile = mergedProfile(client);
  return first(profile.problems) || first(profile.facts) || client.lastUserText || "Краткая память пока не сформирована.";
}

function mergeRisk(current: ClientSummary["riskLevel"] | undefined, next: ClientSummary["riskLevel"] | undefined): ClientSummary["riskLevel"] {
  if (current === "urgent" || next === "urgent") return "urgent";
  if (current === "watch" || next === "watch") return "watch";
  return "none";
}

function first(values: string[] | undefined): string | undefined {
  return values?.find((value) => value.trim().length > 0);
}

function oneLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function tail(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function memoryJournalKey(chatId: string): string {
  return `client_memory/${safeKey(chatId)}/journal.md`;
}

function longTermMemoryKey(chatId: string): string {
  return `client_memory/${safeKey(chatId)}/long_term.md`;
}

function memoryStateKey(chatId: string): string {
  return `client_memory/${safeKey(chatId)}/state.json`;
}

function safeKey(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}
