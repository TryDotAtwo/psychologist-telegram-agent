import type { Env } from "./types";
import { readStoredJson, writeStoredJson } from "./storage";

export type GoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  email?: string;
};

const TOKEN_KEY = "auth/google_tokens.json";
const SCOPE = "openid email profile https://www.googleapis.com/auth/calendar.events";

export function googleOAuthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && allowedGoogleEmails(env).length);
}

export function allowedGoogleEmails(env: Env): string[] {
  return [...new Set([env.GOOGLE_ADMIN_EMAIL ?? "", env.GOOGLE_ADMIN_EMAILS ?? ""]
    .join(",")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

export function googleEmailAllowed(env: Env, email: string | null | undefined): boolean {
  return Boolean(email && allowedGoogleEmails(env).includes(email.toLowerCase()));
}

export function googleRedirectUri(request: Request): string {
  const url = new URL(request.url);
  const prefix = request.headers.get("X-Dashboard-Prefix") ?? (url.pathname.startsWith("/bot/") ? "/bot" : "");
  return `${url.origin}${prefix}/api/auth/google/callback`;
}

export async function createGoogleAuthUrl(request: Request, env: Env): Promise<string> {
  const state = crypto.randomUUID();
  await writeStoredJson(env, `auth/google_state_${state}.json`, { createdAt: Date.now() });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", googleRedirectUri(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleGoogleCallback(request: Request, env: Env): Promise<{ ok: boolean; error?: string; tokens?: GoogleTokens }> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { ok: false, error: "missing_code_or_state" };
  const storedState = await readStoredJson<{ createdAt: number } | null>(env, `auth/google_state_${state}.json`, null);
  if (!storedState || Date.now() - storedState.createdAt > 10 * 60 * 1000) return { ok: false, error: "invalid_state" };

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: googleRedirectUri(request)
    })
  });
  if (!tokenResponse.ok) return { ok: false, error: `token_status_${tokenResponse.status}` };
  const tokenData = (await tokenResponse.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const email = await readGoogleEmail(tokenData.access_token);
  if (!email || !googleEmailAllowed(env, email)) {
    return { ok: false, error: "email_not_allowed" };
  }
  const previous = await readGoogleTokens(env);
  const tokens: GoogleTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? previous?.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    email
  };
  await writeStoredJson(env, TOKEN_KEY, tokens);
  return { ok: true, tokens };
}

export async function readGoogleTokens(env: Env): Promise<GoogleTokens | null> {
  return readStoredJson<GoogleTokens | null>(env, TOKEN_KEY, null);
}

export async function getGoogleAccessToken(env: Env): Promise<string | null> {
  const tokens = await readGoogleTokens(env);
  if (!tokens?.refresh_token) return tokens?.access_token ?? null;
  if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token
    })
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { access_token: string; expires_in?: number };
  const next = { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
  await writeStoredJson(env, TOKEN_KEY, next);
  return data.access_token;
}

async function readGoogleEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { email?: string };
  return data.email ?? null;
}
