import { appendClientMemoryMarkdown } from "./client_memory";
import { memoryStub } from "./memory";
import { appendStoredJsonl, readStoredJson, upsertClient, writeStoredJson } from "./storage";
import { escapeTelegramHtml, sendTelegramMedia, sendTelegramMessage } from "./telegram";
import type { ClientSummary, Env, OutboundAttachment, ScheduledOutboundMessage } from "./types";

const OUTBOUND_KEY = "outbound/scheduled_messages.json";
const MANUAL_HANDOFF_MS = 24 * 60 * 60 * 1000;

export async function listScheduledOutboundMessages(env: Env, chatId?: string): Promise<ScheduledOutboundMessage[]> {
  const messages = await readScheduledOutboundMessages(env);
  return messages
    .filter((message) => message.status === "scheduled")
    .filter((message) => !chatId || message.chatId === chatId)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export async function scheduleOutboundMessage(
  env: Env,
  input: { chatId: string; text?: string; dueAt: string; attachments?: OutboundAttachment[] }
): Promise<ScheduledOutboundMessage | null> {
  if ((!input.text?.trim() && !input.attachments?.length) || Number.isNaN(Date.parse(input.dueAt))) return null;
  const now = new Date().toISOString();
  const message: ScheduledOutboundMessage = {
    id: `outbound_${crypto.randomUUID()}`,
    chatId: input.chatId,
    text: (input.text || "").trim().slice(0, 3500),
    dueAt: new Date(input.dueAt).toISOString(),
    status: "scheduled",
    source: "admin",
    attachments: input.attachments || [],
    createdAt: now,
    updatedAt: now
  };
  const messages = await readScheduledOutboundMessages(env);
  messages.push(message);
  await writeScheduledOutboundMessages(env, messages);
  await markManualHandoff(env, input.chatId, now);
  return message;
}

export async function storeOutboundAttachment(env: Env, messageId: string, file: File): Promise<OutboundAttachment> {
  if (!env.BOT_OBJECTS) throw new Error("r2_required_for_scheduled_media");
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "media";
  const key = `outbound/attachments/${messageId}/${crypto.randomUUID()}_${safeName}`;
  await env.BOT_OBJECTS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" }
  });
  return { key, filename: file.name || safeName, mimeType: file.type || "application/octet-stream", size: file.size };
}

export async function processScheduledOutboundMessages(env: Env): Promise<{ checked: number; sent: number; failed: number }> {
  const messages = await readScheduledOutboundMessages(env);
  const due = messages.filter((message) => message.status === "scheduled" && Date.parse(message.dueAt) <= Date.now()).slice(0, 10);
  let sent = 0;
  let failed = 0;
  for (const message of due) {
    const result = await sendScheduledOutboundMessage(env, message);
    if (result.status === "sent") sent += 1;
    else failed += 1;
  }
  return { checked: due.length, sent, failed };
}

export async function recordAdminOutbound(
  env: Env,
  chatId: string,
  text: string,
  createdAt: string,
  attachments: OutboundAttachment[] = []
): Promise<ClientSummary> {
  const transcriptText = text || attachmentSummary(attachments);
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, {
    role: "assistant",
    text: transcriptText,
    createdAt,
    source: "admin",
    attachments
  });
  await appendClientMemoryMarkdown(env, chatId, { role: "assistant", text: transcriptText, createdAt, source: "admin" });
  await memoryStub(env, chatId).fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "assistant", text: transcriptText, createdAt })
  });
  const botPausedUntil = new Date(Date.now() + MANUAL_HANDOFF_MS).toISOString();
  const client = await upsertClient(env, {
    chatId,
    lastAssistantText: transcriptText,
    lastMessageAt: createdAt,
    lastAdminReplyAt: createdAt,
    attentionAt: createdAt,
    attentionReason: "manual_dialog_active",
    botPausedUntil,
    botPausedBy: "admin",
    botPausedReason: "manual_admin_reply"
  });
  await appendStoredJsonl(env, "logs/manual_handoff_events.jsonl", {
    chatId,
    action: "pause",
    botPausedUntil,
    createdAt
  });
  return client;
}

async function sendScheduledOutboundMessage(env: Env, message: ScheduledOutboundMessage): Promise<ScheduledOutboundMessage> {
  try {
    await sendOutboundPayload(env, message.chatId, message.text, message.attachments);
    const sentAt = new Date().toISOString();
    await recordAdminOutbound(env, message.chatId, message.text, sentAt, message.attachments);
    return updateScheduledOutboundMessage(env, message.id, { status: "sent", sentAt, lastError: undefined });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    await appendStoredJsonl(env, "logs/outbound_send_errors.jsonl", {
      id: message.id,
      chatId: message.chatId,
      message: lastError,
      createdAt: new Date().toISOString()
    });
    return updateScheduledOutboundMessage(env, message.id, { status: "failed", lastError });
  }
}

export async function sendOutboundPayload(env: Env, chatId: string, text: string, attachments: OutboundAttachment[]): Promise<void> {
  if (!attachments.length) {
    await sendTelegramMessage(env, chatId, escapeTelegramHtml(text));
    return;
  }
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    if (!attachment.key || !env.BOT_OBJECTS) throw new Error("scheduled_attachment_not_found");
    const object = await env.BOT_OBJECTS.get(attachment.key);
    if (!object) throw new Error(`scheduled_attachment_missing:${attachment.key}`);
    await sendTelegramMedia(env, chatId, {
      blob: await object.blob(),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      caption: index === 0 ? text : ""
    });
  }
}

async function readScheduledOutboundMessages(env: Env): Promise<ScheduledOutboundMessage[]> {
  const messages = await readStoredJson<ScheduledOutboundMessage[]>(env, OUTBOUND_KEY, []);
  return messages.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

async function writeScheduledOutboundMessages(env: Env, messages: ScheduledOutboundMessage[]): Promise<void> {
  await writeStoredJson(env, OUTBOUND_KEY, messages);
}

async function updateScheduledOutboundMessage(
  env: Env,
  id: string,
  patch: Partial<ScheduledOutboundMessage>
): Promise<ScheduledOutboundMessage> {
  const messages = await readScheduledOutboundMessages(env);
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) throw new Error(`scheduled_outbound_not_found:${id}`);
  const next = { ...messages[index], ...patch, id, updatedAt: new Date().toISOString() };
  messages[index] = next;
  await writeScheduledOutboundMessages(env, messages);
  return next;
}

async function markManualHandoff(env: Env, chatId: string, createdAt: string): Promise<void> {
  const botPausedUntil = new Date(Date.now() + MANUAL_HANDOFF_MS).toISOString();
  await upsertClient(env, {
    chatId,
    attentionAt: createdAt,
    attentionReason: "manual_dialog_active",
    botPausedUntil,
    botPausedBy: "admin",
    botPausedReason: "manual_admin_scheduled_reply"
  });
}

function attachmentSummary(attachments: OutboundAttachment[]): string {
  if (!attachments.length) return "";
  return `Вложение: ${attachments.map((attachment) => attachment.filename).join(", ")}`;
}
