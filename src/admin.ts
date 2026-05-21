import type { BotConfig, CalendarSlot, ClientSummary, Env } from "./types";
import { calendarConnectionStatus, syncGoogleCalendarCache } from "./calendar";
import { createGoogleAuthUrl, handleGoogleCallback } from "./google";
import { memoryStub } from "./memory";
import {
  appendStoredJsonl,
  readConfig,
  readSlots,
  readTranscript,
  readUsers,
  upsertClient,
  writeConfig,
  writeSlots,
  writeUsers
} from "./storage";
import { sendTelegramMessage } from "./telegram";

const SESSION_COOKIE = "admin_session";

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/login") return login(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return logout();
  if (request.method === "GET" && url.pathname === "/api/session") return Response.json({ authenticated: authorized(request, env) });
  if (request.method === "GET" && url.pathname === "/api/auth/google") return startGoogleLogin(request, env);
  if (request.method === "GET" && url.pathname === "/api/auth/google/callback") return finishGoogleLogin(request, env);
  if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (request.method === "GET" && url.pathname === "/api/config") return Response.json(await readConfig(env));
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const config = (await request.json()) as BotConfig;
    await writeConfig(env, config);
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/users") return Response.json(await readUsers(env));
  const userRoute = parseUserRoute(url.pathname);
  if (userRoute && request.method === "GET" && userRoute.action === "messages") {
    return Response.json(await readTranscript(env, userRoute.chatId));
  }
  if (userRoute && request.method === "PUT" && userRoute.action === "profile") {
    return Response.json(await updateUserProfile(request, env, userRoute.chatId));
  }
  if (userRoute && request.method === "POST" && userRoute.action === "reply") {
    return sendAdminReply(request, env, userRoute.chatId);
  }
  if (request.method === "GET" && url.pathname === "/api/slots") return Response.json(await readSlots(env));
  if (request.method === "PUT" && url.pathname === "/api/slots") {
    const slots = (await request.json()) as CalendarSlot[];
    await writeSlots(env, slots);
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/calendar/sync") return Response.json(await syncGoogleCalendarCache(env));
  if (request.method === "GET" && url.pathname === "/api/calendar/status") return Response.json(await calendarConnectionStatus(env));
  return Response.json({ error: "not_found" }, { status: 404 });
}

function parseUserRoute(pathname: string): { chatId: string; action: "profile" | "messages" | "reply" } | null {
  const match = pathname.match(/^\/api\/users\/([^/]+)(?:\/(messages|reply))?$/);
  if (!match) return null;
  const action = match[2] === "messages" || match[2] === "reply" ? match[2] : "profile";
  return { chatId: decodeURIComponent(match[1]), action };
}

async function updateUserProfile(request: Request, env: Env, chatId: string): Promise<ClientSummary> {
  const body = (await request.json()) as Partial<ClientSummary>;
  const users = await readUsers(env);
  const index = users.findIndex((user) => user.chatId === chatId);
  const current: ClientSummary =
    index >= 0
      ? users[index]
      : {
          chatId,
          lastMessageAt: new Date().toISOString(),
          messageCount: 0,
          tags: [],
          facts: [],
          reminders: [],
          riskLevel: "none"
        };
  const next: ClientSummary = {
    ...current,
    username: body.username ?? current.username,
    firstName: body.firstName ?? current.firstName,
    lastName: body.lastName ?? current.lastName,
    tags: normalizeList(body.tags ?? current.tags),
    facts: normalizeList(body.facts ?? current.facts),
    reminders: normalizeList(body.reminders ?? current.reminders),
    riskLevel: body.riskLevel ?? current.riskLevel,
    nextAction: body.nextAction ?? current.nextAction,
    lastMessageAt: current.lastMessageAt
  };
  if (index >= 0) users[index] = next;
  else users.push(next);
  await writeUsers(env, users);
  return next;
}

async function sendAdminReply(request: Request, env: Env, chatId: string): Promise<Response> {
  const body = (await request.json()) as { text?: string };
  const text = body.text?.trim();
  if (!text) return Response.json({ error: "empty_text" }, { status: 400 });
  if (text.length > 3500) return Response.json({ error: "text_too_long" }, { status: 400 });
  try {
    await sendTelegramMessage(env, chatId, escapeTelegramHtml(text));
  } catch (error) {
    return Response.json(
      { error: "telegram_send_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
  const createdAt = new Date().toISOString();
  await appendStoredJsonl(env, `transcripts/${chatId}.jsonl`, { role: "assistant", text, createdAt, source: "admin" });
  await memoryStub(env, chatId).fetch("https://memory/turn", {
    method: "POST",
    body: JSON.stringify({ role: "assistant", text, createdAt })
  });
  await upsertClient(env, { chatId, lastAssistantText: text, lastMessageAt: createdAt });
  return Response.json({ ok: true, createdAt });
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 50);
}

function escapeTelegramHtml(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return value.replace(/[&<>]/g, (char) => map[char] ?? char);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { password?: string };
  const expectedPassword = env.ADMIN_PASSWORD || env.ADMIN_TOKEN;
  if (!body.password || body.password !== expectedPassword) {
    return Response.json({ error: "invalid_password" }, { status: 401 });
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `${SESSION_COOKIE}=${env.ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
      }
    }
  );
}

function logout(): Response {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      }
    }
  );
}

async function startGoogleLogin(request: Request, env: Env): Promise<Response> {
  const prefix = request.headers.get("X-Dashboard-Prefix") ?? "";
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_ADMIN_EMAIL) {
    return Response.redirect(`${new URL(request.url).origin}${prefix}/?google=not_configured`, 302);
  }
  return Response.redirect(await createGoogleAuthUrl(request, env), 302);
}

async function finishGoogleLogin(request: Request, env: Env): Promise<Response> {
  const result = await handleGoogleCallback(request, env);
  const origin = new URL(request.url).origin;
  const prefix = request.headers.get("X-Dashboard-Prefix") ?? "";
  if (!result.ok) return Response.redirect(`${origin}${prefix}/?google=${encodeURIComponent(result.error ?? "failed")}`, 302);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}${prefix}/?google=connected`,
      "Set-Cookie": `${SESSION_COOKIE}=${env.ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
    }
  });
}

function authorized(request: Request, env: Env): boolean {
  const bearer = request.headers.get("Authorization") ?? "";
  if (bearer === `Bearer ${env.ADMIN_TOKEN}`) return true;
  return readCookie(request, SESSION_COOKIE) === env.ADMIN_TOKEN;
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const parts = cookie.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
