import { createBooking, listAvailability } from "./calendar";
import { answerWithOpenAI } from "./openai";
import {
  appendConsentRecord,
  appendSiteTranscriptMessage,
  appendTranscriptMessage,
  readConfig,
  readSiteArticles,
  readSiteConfig,
  readSiteLinkToken,
  readSiteRateBucket,
  readSiteSession,
  readSiteTranscript,
  readStoredJson,
  upsertClient,
  upsertSiteArticle,
  writeSiteAsset,
  writeSiteArticles,
  writeSiteConfig,
  writeSiteLinkToken,
  writeSiteRateBucket,
  writeSiteSession,
  writeStoredJson
} from "./storage";
import type {
  ConsentRecord,
  Env,
  SiteArticle,
  SiteConfig,
  SiteLinkToken,
  SiteRateBucket,
  SiteSession,
  SiteTranscriptMessage
} from "./types";

export const SITE_SESSION_COOKIE = "site_session";
export const SITE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SITE_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
const SITE_RATE_WINDOW_MS = 60 * 1000;
const SITE_RATE_LIMIT = 12;
const SITE_CLIENT_PREFIX = "site:";
const TELEGRAM_CHANNEL_USERNAME = "ASD_there";
const TELEGRAM_CHANNEL_PUBLIC_URL = `https://t.me/s/${TELEGRAM_CHANNEL_USERNAME}`;
const TELEGRAM_CHANNEL_SYNC_KEY = `site/telegram/${TELEGRAM_CHANNEL_USERNAME}/sync.json`;
const TELEGRAM_CHANNEL_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;
const TELEGRAM_ARTICLE_PREFIX = `telegram_${TELEGRAM_CHANNEL_USERNAME}_`;

type JsonValue = Record<string, unknown> | unknown[];
type PublicSiteConfig = Omit<SiteConfig, "articleAgentInstructions">;
type PublicArticle = Omit<SiteArticle, "id" | "coverImageKey">;
type TelegramChannelPost = { id: number; url: string; date?: string; text: string };
type TelegramChannelSyncState = {
  checkedAt?: string;
  lastImportedAt?: string;
  lastPostId?: number;
  lastError?: string;
  importedCount?: number;
  updatedCount?: number;
};

export function buildSiteSessionCookie(sessionId: string, expiresAt: string): string {
  return `${SITE_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SITE_SESSION_TTL_MS / 1000)}; Expires=${new Date(expiresAt).toUTCString()}`;
}

export function clearSiteSessionCookie(): string {
  return `${SITE_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function siteSessionExpired(session: SiteSession, now = new Date()): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

export function consentRequired(session: SiteSession | null): boolean {
  return !session?.consentAcceptedAt || !session.consentVersion;
}

export function hasCurrentConsent(session: SiteSession | null, config: SiteConfig): boolean {
  return Boolean(session?.consentAcceptedAt && session.consentVersion === config.consentVersion && !siteSessionExpired(session));
}

export function publicSiteConfig(config: SiteConfig): PublicSiteConfig {
  const { articleAgentInstructions: _articleAgentInstructions, ...publicConfig } = config;
  return publicConfig;
}

export function publicArticle(article: SiteArticle): PublicArticle {
  const { id: _id, coverImageKey: _coverImageKey, ...visible } = article;
  return visible;
}

export function normalizeSiteArticleDraft(input: Partial<SiteArticle> & { title?: string; bodyMarkdown?: string }): SiteArticle {
  const now = new Date().toISOString();
  const title = (input.title || "Новая статья").trim().slice(0, 180);
  const bodyMarkdown = (input.bodyMarkdown || "").trim().slice(0, 40_000);
  return {
    id: input.id || `article_${crypto.randomUUID()}`,
    slug: uniqueSlugPart(input.slug || slugifyRu(title)),
    title,
    summary: (input.summary || firstSentence(bodyMarkdown) || "Черновик статьи").trim().slice(0, 500),
    bodyMarkdown,
    status: input.status === "published" || input.status === "archived" ? input.status : "draft",
    tags: normalizeTags(input.tags),
    coverImageKey: input.coverImageKey,
    coverImageUrl: input.coverImageUrl,
    seoTitle: input.seoTitle?.trim().slice(0, 180),
    seoDescription: input.seoDescription?.trim().slice(0, 300),
    createdAt: input.createdAt || now,
    updatedAt: now,
    publishedAt: input.publishedAt
  };
}

export async function hashSiteLinkToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchSiteAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/site" || url.pathname === "/site/") url.pathname = "/site/";
  else if (!url.pathname.startsWith("/site/api/") && !url.pathname.split("/").at(-1)?.includes(".")) url.pathname = "/site/";
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

export async function handleSiteApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = await readSiteConfig(env);
  const sessionContext = await getOrCreateSiteSession(request, env);
  const session = sessionContext.session;

  if (request.method === "GET" && url.pathname === "/site/api/config") {
    const botConfig = await readConfig(env);
    return json(
      {
        config: publicSiteConfig(config),
        services: botConfig.services,
        prices: botConfig.prices,
        session: publicSession(session, config)
      },
      200,
      sessionContext.cookie
    );
  }
  if (request.method === "GET" && url.pathname === "/site/api/session") {
    return json({ session: publicSession(session, config) }, 200, sessionContext.cookie);
  }
  if (request.method === "POST" && url.pathname === "/site/api/consent") {
    const body = (await request.json().catch(() => ({}))) as { accepted?: boolean; name?: string; contact?: string };
    if (!body.accepted) return json({ error: "consent_required" }, 400, sessionContext.cookie);
    const acceptedAt = new Date().toISOString();
    const next: SiteSession = {
      ...session,
      name: cleanOptional(body.name, 120),
      contact: cleanOptional(body.contact, 180),
      consentVersion: config.consentVersion,
      consentAcceptedAt: acceptedAt
    };
    await writeSiteSession(env, next);
    const record: ConsentRecord = {
      id: `consent_${crypto.randomUUID()}`,
      siteSessionId: next.id,
      consentVersion: config.consentVersion,
      consentText: config.consentText,
      privacyText: config.privacyText,
      acceptedAt
    };
    await appendConsentRecord(env, record);
    return json({ ok: true, session: publicSession(next, config) }, 200, buildSiteSessionCookie(next.id, next.expiresAt));
  }
  if (request.method === "GET" && url.pathname === "/site/api/articles") {
    const articles = (await readSiteArticles(env)).filter((article) => article.status === "published").map(publicArticle);
    return json({ articles }, 200, sessionContext.cookie);
  }
  const articleMatch = url.pathname.match(/^\/site\/api\/articles\/([^/]+)$/);
  if (request.method === "GET" && articleMatch) {
    const slug = decodeURIComponent(articleMatch[1]);
    const article = (await readSiteArticles(env)).find((item) => item.slug === slug && item.status === "published");
    return article ? json({ article: publicArticle(article) }, 200, sessionContext.cookie) : json({ error: "not_found" }, 404, sessionContext.cookie);
  }
  const assetMatch = url.pathname.match(/^\/site\/api\/assets\/(.+)$/);
  if (request.method === "GET" && assetMatch) return fetchSiteStoredAsset(env, decodeURIComponent(assetMatch[1]));

  if (!config.enabled) return json({ error: "site_disabled" }, 503, sessionContext.cookie);
  if (request.method === "GET" && url.pathname === "/site/api/chat") {
    if (!hasCurrentConsent(session, config)) return json({ error: "consent_required" }, 403, sessionContext.cookie);
    return json({ messages: await readSiteTranscript(env, session.id), session: publicSession(session, config) }, 200, sessionContext.cookie);
  }
  if (request.method === "POST" && url.pathname === "/site/api/chat") {
    if (!config.webBotEnabled) return json({ error: "web_bot_disabled" }, 503, sessionContext.cookie);
    if (!hasCurrentConsent(session, config)) return json({ error: "consent_required" }, 403, sessionContext.cookie);
    const body = (await request.json().catch(() => ({}))) as { text?: string; turnstileToken?: string };
    const text = cleanRequired(body.text, 1500);
    if (!text) return json({ error: "empty_text" }, 400, sessionContext.cookie);
    const protection = await validatePublicProtection(request, env, session.id, "chat", body.turnstileToken);
    if (!protection.ok) return json({ error: protection.error }, protection.status, sessionContext.cookie);
    return json(await handleSiteChat(env, session, text), 200, sessionContext.cookie);
  }
  if (request.method === "GET" && url.pathname === "/site/api/availability") {
    const from = url.searchParams.get("from") || new Date().toISOString();
    const to = url.searchParams.get("to") || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const durationMinutes = clampNumber(Number(url.searchParams.get("durationMinutes") || "30"), 15, 180, 30);
    return json({ availability: await listAvailability(env, from, to, durationMinutes, 80) }, 200, sessionContext.cookie);
  }
  if (request.method === "POST" && url.pathname === "/site/api/bookings") {
    if (!hasCurrentConsent(session, config)) return json({ error: "consent_required" }, 403, sessionContext.cookie);
    const body = (await request.json().catch(() => ({}))) as {
      availabilityId?: string;
      serviceId?: string;
      durationMinutes?: number;
      name?: string;
      contact?: string;
      request?: string;
      turnstileToken?: string;
    };
    const protection = await validatePublicProtection(request, env, session.id, "booking", body.turnstileToken);
    if (!protection.ok) return json({ error: protection.error }, protection.status, sessionContext.cookie);
    const booking = await createSiteBooking(env, session, body);
    return booking ? json({ ok: true, booking, chatId: siteChatId(session.id) }, 200, sessionContext.cookie) : json({ error: "availability_not_found_or_busy" }, 409, sessionContext.cookie);
  }
  if (request.method === "POST" && url.pathname === "/site/api/telegram-link") {
    if (!hasCurrentConsent(session, config)) return json({ error: "consent_required" }, 403, sessionContext.cookie);
    const body = (await request.json().catch(() => ({}))) as { turnstileToken?: string };
    const protection = await validatePublicProtection(request, env, session.id, "telegram_link", body.turnstileToken);
    if (!protection.ok) return json({ error: protection.error }, protection.status, sessionContext.cookie);
    const link = await createTelegramLink(env, config, session);
    return json(link, 200, sessionContext.cookie);
  }

  return json({ error: "not_found" }, 404, sessionContext.cookie);
}

export async function handleAdminSiteApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/site/config") return Response.json(await readSiteConfig(env));
  if (request.method === "PUT" && url.pathname === "/api/site/config") {
    const body = (await request.json()) as SiteConfig;
    await writeSiteConfig(env, body);
    return Response.json({ ok: true, config: await readSiteConfig(env) });
  }
  if (request.method === "GET" && url.pathname === "/api/site/articles") {
    return Response.json(await readSiteArticles(env));
  }
  if (request.method === "POST" && url.pathname === "/api/site/articles/sync-channel") {
    return Response.json(await syncTelegramChannelArticles(env, { force: true }));
  }
  if (request.method === "POST" && url.pathname === "/api/site/articles") {
    return Response.json({ error: "telegram_channel_source_required" }, { status: 405 });
  }
  if (request.method === "POST" && url.pathname === "/api/site/articles/generate") {
    return Response.json({ error: "telegram_channel_source_required" }, { status: 405 });
  }
  const articleRoute = url.pathname.match(/^\/api\/site\/articles\/([^/]+)(?:\/(publish|unpublish|cover|generate-image))?$/);
  if (articleRoute) {
    const id = decodeURIComponent(articleRoute[1]);
    const action = articleRoute[2];
    if (request.method === "PUT" && !action) return Response.json(await updateArticle(env, id, (await request.json()) as Partial<SiteArticle>));
    if (request.method === "POST" && action === "publish") return Response.json(await setArticleStatus(env, id, "published"));
    if (request.method === "POST" && action === "unpublish") return Response.json(await setArticleStatus(env, id, "draft"));
    if (request.method === "POST" && action === "cover") return uploadArticleCover(request, env, id);
    if (request.method === "POST" && action === "generate-image") return Response.json(await generateArticleImage(request, env, id));
  }
  return null;
}

export async function syncTelegramChannelArticles(env: Env, options: { force?: boolean } = {}): Promise<{
  ok: boolean;
  skipped: boolean;
  imported: number;
  updated: number;
  posts: number;
  articles: SiteArticle[];
  state: TelegramChannelSyncState;
}> {
  const now = new Date();
  const previous = await readStoredJson<TelegramChannelSyncState>(env, TELEGRAM_CHANNEL_SYNC_KEY, {});
  if (!options.force && previous.checkedAt && now.getTime() - Date.parse(previous.checkedAt) < TELEGRAM_CHANNEL_SYNC_MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, imported: 0, updated: 0, posts: 0, articles: await readSiteArticles(env), state: previous };
  }

  try {
    const posts = await fetchTelegramChannelPosts();
    const groups = groupTelegramPosts(posts);
    const existing = await readSiteArticles(env);
    const byId = new Map(existing.map((article) => [article.id, article]));
    let imported = 0;
    let updated = 0;

    for (const group of groups) {
      const id = `${TELEGRAM_ARTICLE_PREFIX}${group[0].id}`;
      const current = byId.get(id);
      const article = telegramGroupToArticle(group, current);
      if (current) updated += article.bodyMarkdown !== current.bodyMarkdown || article.title !== current.title || article.summary !== current.summary ? 1 : 0;
      else imported += 1;
      byId.set(id, article);
    }

    const next = [...byId.values()].sort((a, b) => Date.parse(b.publishedAt || b.createdAt) - Date.parse(a.publishedAt || a.createdAt));
    await writeSiteArticles(env, next);
    const state: TelegramChannelSyncState = {
      checkedAt: now.toISOString(),
      lastImportedAt: imported || updated ? now.toISOString() : previous.lastImportedAt,
      lastPostId: posts.reduce((max, post) => Math.max(max, post.id), previous.lastPostId || 0),
      importedCount: (previous.importedCount || 0) + imported,
      updatedCount: (previous.updatedCount || 0) + updated
    };
    await writeStoredJson(env, TELEGRAM_CHANNEL_SYNC_KEY, state);
    return { ok: true, skipped: false, imported, updated, posts: posts.length, articles: next, state };
  } catch (error) {
    const state: TelegramChannelSyncState = {
      ...previous,
      checkedAt: now.toISOString(),
      lastError: error instanceof Error ? error.message : String(error)
    };
    await writeStoredJson(env, TELEGRAM_CHANNEL_SYNC_KEY, state);
    return { ok: false, skipped: false, imported: 0, updated: 0, posts: 0, articles: await readSiteArticles(env), state };
  }
}

export async function consumeSiteTelegramStart(env: Env, rawToken: string, telegramChatId: string, profile: { username?: string; firstName?: string; lastName?: string }): Promise<boolean> {
  const tokenHash = await hashSiteLinkToken(rawToken);
  const token = await readSiteLinkToken(env, tokenHash);
  if (!token || token.consumedAt || Date.parse(token.expiresAt) <= Date.now()) return false;
  const session = await readSiteSession(env, token.siteSessionId);
  if (!session) return false;
  const now = new Date().toISOString();
  const nextToken: SiteLinkToken = { ...token, consumedAt: now, telegramChatId };
  await writeSiteLinkToken(env, nextToken);
  await writeSiteSession(env, { ...session, linkedTelegramChatId: telegramChatId });
  const siteMessages = await readSiteTranscript(env, session.id);
  for (const message of siteMessages.slice(-50)) {
    await appendTranscriptMessage(env, telegramChatId, {
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      source: message.source === "site" ? "telegram" : message.source === "admin" ? "admin" : "bot"
    });
  }
  await upsertClient(env, {
    chatId: telegramChatId,
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    lastMessageAt: now,
    tags: ["site-linked"],
    facts: ["Клиент связал сайт и Telegram через явный deep-link."],
    nextAction: "Проверить контекст сайта и продолжить диалог в Telegram."
  });
  await upsertClient(env, {
    chatId: siteChatId(session.id),
    lastMessageAt: now,
    tags: ["telegram-linked"],
    nextAction: `Сессия сайта связана с Telegram chat_id=${telegramChatId}.`
  });
  return true;
}

export function isSiteChatId(chatId: string): boolean {
  return chatId.startsWith(SITE_CLIENT_PREFIX);
}

export function siteSessionIdFromChatId(chatId: string): string | null {
  return isSiteChatId(chatId) ? chatId.slice(SITE_CLIENT_PREFIX.length) : null;
}

export async function recordSiteAdminReply(env: Env, chatId: string, text: string, createdAt: string): Promise<void> {
  const siteSessionId = siteSessionIdFromChatId(chatId);
  if (!siteSessionId) return;
  await appendSiteTranscriptMessage(env, siteSessionId, { role: "assistant", text, createdAt, source: "admin" });
  await appendTranscriptMessage(env, chatId, { role: "assistant", text, createdAt, source: "admin" });
  await upsertClient(env, { chatId, lastMessageAt: createdAt, lastAssistantText: text, lastAdminReplyAt: createdAt });
}

async function fetchTelegramChannelPosts(): Promise<TelegramChannelPost[]> {
  const response = await fetch(TELEGRAM_CHANNEL_PUBLIC_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 compatible; site-article-sync/1.0",
      Accept: "text/html"
    }
  });
  if (!response.ok) throw new Error(`telegram_channel_fetch_${response.status}`);
  const html = await response.text();
  const posts: TelegramChannelPost[] = [];
  const blockPattern = /<div class="tgme_widget_message[^"]*"[^>]*data-post="ASD_there\/(\d+)"[\s\S]*?(?=<div class="tgme_widget_message|\s*<\/section>)/g;
  for (const match of html.matchAll(blockPattern)) {
    const id = Number(match[1]);
    const block = match[0];
    const rawText = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "";
    const text = htmlToPlainText(rawText);
    if (!Number.isFinite(id) || text.length < 80) continue;
    const date = block.match(/<time datetime="([^"]+)"/)?.[1];
    posts.push({ id, url: `https://t.me/${TELEGRAM_CHANNEL_USERNAME}/${id}`, date, text });
  }
  return posts.sort((a, b) => a.id - b.id).slice(-80);
}

function groupTelegramPosts(posts: TelegramChannelPost[]): TelegramChannelPost[][] {
  const groups: TelegramChannelPost[][] = [];
  const byTopic = new Map<string, TelegramChannelPost[]>();
  for (const post of posts) {
    const key = telegramSeriesKey(post.text);
    if (key && /(?:част[ьи]\s*[2-9]|[2-9]\s*част[ьи]|продолжение)/i.test(post.text.slice(0, 180))) {
      const group = byTopic.get(key);
      if (group) {
        group.push(post);
        continue;
      }
    }
    const previous = groups.at(-1);
    if (previous && shouldJoinTelegramPost(previous, post)) {
      previous.push(post);
      if (key) byTopic.set(key, previous);
    } else {
      const group = [post];
      groups.push(group);
      if (key) byTopic.set(key, group);
    }
  }
  return groups.filter((group) => group.map((post) => post.text).join("\n").length >= 160);
}

function telegramSeriesKey(text: string): string | null {
  const firstLine = text.split(/\n+/)[0]?.trim() || "";
  const normalized = firstLine
    .toLowerCase()
    .replace(/["«»]/g, "")
    .replace(/\b(?:пост\s*)?\d+[.)]\s*/i, "")
    .replace(/\b(?:част[ьи]\s*\d+|\d+\s*част[ьи]|продолжение)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 12) return null;
  return normalized.split(" ").slice(0, 7).join(" ");
}

function shouldJoinTelegramPost(group: TelegramChannelPost[], next: TelegramChannelPost): boolean {
  if (group.length >= 3) return false;
  const previous = group.at(-1);
  if (!previous?.date || !next.date) return false;
  const hours = Math.abs(Date.parse(next.date) - Date.parse(previous.date)) / (60 * 60 * 1000);
  if (hours > 4) return false;
  const text = next.text.trim();
  const startsAsContinuation = /^[а-яёa-z0-9(—-]/i.test(text) || /^[•\-–]/.test(text);
  const previousContinues = /[:,;—-]\s*$/.test(previous.text.trim());
  return startsAsContinuation || previousContinues || group.map((post) => post.text).join("\n").length < 1200;
}

function telegramGroupToArticle(group: TelegramChannelPost[], current?: SiteArticle): SiteArticle {
  const now = new Date().toISOString();
  const first = group[0];
  const combined = group.map((post) => post.text.trim()).join("\n\n---\n\n");
  const title = extractTelegramArticleTitle(combined, first.id);
  const tags = extractTelegramTags(combined);
  const bodyMarkdown = [
    `# ${title}`,
    "",
    `_Источник: [Telegram-канал ASD_there](${first.url})_`,
    "",
    combined
  ].join("\n");
  const createdAt = first.date || current?.createdAt || now;
  const slugTail = uniqueSlugPart(slugifyRu(title) || `post-${first.id}`);
  return {
    id: `${TELEGRAM_ARTICLE_PREFIX}${first.id}`,
    slug: current?.slug || `telegram-${first.id}-${slugTail}`,
    title,
    summary: firstSentence(combined).slice(0, 300) || "Материал из Telegram-канала психолога.",
    bodyMarkdown,
    status: current?.status || "published",
    tags,
    coverImageKey: current?.coverImageKey,
    coverImageUrl: current?.coverImageUrl || coverForTags(tags),
    seoTitle: current?.seoTitle || title,
    seoDescription: current?.seoDescription || (firstSentence(combined).slice(0, 220) || title),
    createdAt,
    updatedAt: now,
    publishedAt: current?.publishedAt || createdAt
  };
}

function extractTelegramArticleTitle(text: string, postId: number): string {
  const line = text
    .split(/\n+/)
    .map((item) => item.replace(/^#+\s*/, "").trim())
    .find((item) => item.length >= 8);
  if (!line) return `Материал из Telegram-канала #${postId}`;
  const sentence = firstSentence(line) || line;
  return sentence.replace(/[.!?]+$/, "").slice(0, 90);
}

function extractTelegramTags(text: string): string[] {
  const lower = text.toLowerCase();
  const tags: string[] = [];
  const candidates: [string, string[]][] = [
    ["РАС", ["рас", "аутизм", "аутич"]],
    ["СДВГ", ["сдвг", "adhd"]],
    ["сенсорика", ["сенсор"]],
    ["маскинг", ["маск"]],
    ["саморегуляция", ["регуляц", "саморегуляц"]],
    ["выгорание", ["выгора", "устал"]],
    ["отношения", ["отношен", "общени"]],
    ["работа", ["работ", "карьер"]],
    ["быт", ["быт", "рутин"]],
    ["нейроотличность", ["нейроотлич", "нейроразно"]]
  ];
  for (const [tag, needles] of candidates) {
    if (needles.some((needle) => lower.includes(needle))) tags.push(tag);
  }
  return tags.length ? tags.slice(0, 6) : ["психообразование"];
}

function coverForTags(tags: string[]): string {
  if (tags.includes("маскинг")) return "/site/assets/mask-reference.png";
  if (tags.includes("саморегуляция") || tags.includes("быт")) return "/site/assets/face-reference.png";
  return "/site/assets/mask-map-reference.png";
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] || "";
  });
}

async function getOrCreateSiteSession(request: Request, env: Env): Promise<{ session: SiteSession; cookie?: string }> {
  const cookieId = readCookie(request, SITE_SESSION_COOKIE);
  const current = cookieId ? await readSiteSession(env, cookieId) : null;
  if (current && !siteSessionExpired(current)) return { session: current };
  const now = new Date();
  const session: SiteSession = {
    id: `site_${crypto.randomUUID()}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SITE_SESSION_TTL_MS).toISOString()
  };
  await writeSiteSession(env, session);
  return { session, cookie: buildSiteSessionCookie(session.id, session.expiresAt) };
}

async function handleSiteChat(env: Env, session: SiteSession, text: string): Promise<{ ok: true; answer: string; messages: SiteTranscriptMessage[] }> {
  const createdAt = new Date().toISOString();
  await appendSiteTranscriptMessage(env, session.id, { role: "user", text, createdAt, source: "site" });
  await appendTranscriptMessage(env, siteChatId(session.id), { role: "user", text, createdAt, source: "telegram" });
  await upsertClient(env, {
    chatId: siteChatId(session.id),
    firstName: session.name,
    lastMessageAt: createdAt,
    lastUserText: text,
    messageCount: (await readSiteTranscript(env, session.id)).filter((message) => message.role === "user").length,
    tags: ["site"],
    nextAction: "Ответить в чат на сайте или предложить связать Telegram."
  });
  const botConfig = await readConfig(env);
  const turns = (await readSiteTranscript(env, session.id)).map((message) => ({
    role: message.role,
    text: message.text,
    createdAt: message.createdAt
  }));
  let answer: string;
  try {
    answer = await answerWithOpenAI(env, botConfig, text, {
      profile: { source: "public_site", consentVersion: session.consentVersion },
      turns
    });
  } catch {
    answer = "Сейчас автоматический ответ недоступен. Сообщение сохранено, психолог сможет увидеть его в панели и ответить вручную.";
  }
  const answeredAt = new Date().toISOString();
  await appendSiteTranscriptMessage(env, session.id, { role: "assistant", text: answer, createdAt: answeredAt, source: "bot" });
  await appendTranscriptMessage(env, siteChatId(session.id), { role: "assistant", text: answer, createdAt: answeredAt, source: "bot" });
  await upsertClient(env, { chatId: siteChatId(session.id), lastMessageAt: answeredAt, lastAssistantText: answer });
  return { ok: true, answer, messages: await readSiteTranscript(env, session.id) };
}

async function createSiteBooking(
  env: Env,
  session: SiteSession,
  body: { availabilityId?: string; serviceId?: string; durationMinutes?: number; name?: string; contact?: string; request?: string }
) {
  const availabilityId = cleanRequired(body.availabilityId, 160);
  const serviceId = cleanOptional(body.serviceId, 120);
  const durationMinutes = clampNumber(Number(body.durationMinutes || "30"), 15, 180, 30);
  if (!availabilityId) return null;
  const name = cleanOptional(body.name, 120) || session.name || "Клиент с сайта";
  const contact = cleanOptional(body.contact, 180) || session.contact;
  const requestText = cleanOptional(body.request, 1000);
  const booking = await createBooking(env, {
    availabilityId,
    durationMinutes,
    chatId: siteChatId(session.id),
    clientName: name,
    serviceId,
    source: "site",
    status: "held"
  });
  if (!booking) return null;
  const updatedAt = new Date().toISOString();
  await writeSiteSession(env, { ...session, name, contact });
  await upsertClient(env, {
    chatId: siteChatId(session.id),
    firstName: name,
    lastMessageAt: updatedAt,
    tags: ["site", "booking"],
    nextAction: "Подтвердить запись с сайта.",
    facts: [`Контакт: ${contact || "не указан"}`, requestText ? `Запрос с сайта: ${requestText}` : ""].filter(Boolean),
    agentProfile: {
      sessionHistory: [{ startsAt: booking.startsAt, durationMinutes: booking.durationMinutes, serviceId: serviceId || (durationMinutes <= 30 ? "intro_30" : "consultation") }]
    }
  });
  await appendSiteTranscriptMessage(env, session.id, {
    role: "assistant",
    text: `Создана предварительная запись: ${booking.startsAt}. Психолог подтвердит время.`,
    createdAt: updatedAt,
    source: "bot"
  });
  return booking;
}

async function createTelegramLink(env: Env, config: SiteConfig, session: SiteSession): Promise<{ telegramUrl: string; expiresAt: string }> {
  const rawToken = crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await hashSiteLinkToken(rawToken);
  const expiresAt = new Date(Date.now() + SITE_LINK_TOKEN_TTL_MS).toISOString();
  await writeSiteLinkToken(env, {
    tokenHash,
    siteSessionId: session.id,
    createdAt: new Date().toISOString(),
    expiresAt
  });
  const base = config.telegramUrl || "https://t.me/practicing_autist_bot";
  const start = `site_${rawToken}`;
  const separator = base.includes("?") ? "&" : "?";
  return { telegramUrl: `${base}${separator}start=${encodeURIComponent(start)}`, expiresAt };
}

async function validatePublicProtection(
  request: Request,
  env: Env,
  sessionId: string,
  action: string,
  turnstileToken?: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const rate = await checkRateLimit(request, env, sessionId, action);
  if (!rate.ok) return rate;
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true };
  if (!turnstileToken) return { ok: false, status: 403, error: "turnstile_required" };
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", turnstileToken);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = (await response.json().catch(() => ({}))) as { success?: boolean };
  return result.success ? { ok: true } : { ok: false, status: 403, error: "turnstile_failed" };
}

async function checkRateLimit(request: Request, env: Env, sessionId: string, action: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const key = `${action}:${sessionId}:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
  const now = Date.now();
  const current = await readSiteRateBucket(env, key);
  const active = current && Date.parse(current.windowStartedAt) + SITE_RATE_WINDOW_MS > now;
  const next: SiteRateBucket = active ? { ...current, count: current.count + 1 } : { key, windowStartedAt: new Date(now).toISOString(), count: 1 };
  await writeSiteRateBucket(env, next);
  return next.count <= SITE_RATE_LIMIT ? { ok: true } : { ok: false, status: 429, error: "rate_limited" };
}

async function generateArticleDraft(env: Env, topic?: string, tone?: string): Promise<SiteArticle> {
  const config = await readSiteConfig(env);
  const publicContext = {
    brandName: config.brandName,
    headline: config.headline,
    bio: config.bio,
    githubUrl: config.githubUrl,
    telegramUrl: config.telegramUrl
  };
  const botConfig = await readConfig(env);
  const articleBotConfig = {
    ...botConfig,
    systemPrompt: "Ты пишешь только черновики публичных статей для сайта. Используй только публичный контекст из сообщения пользователя.",
    crisisPrompt: "",
    searchEnabled: false
  };
  const prompt = [
    config.articleAgentInstructions,
    "Создай черновик статьи для публичного сайта. Используй только публичный контекст ниже. Нельзя использовать клиентские чаты, профили, заметки, записи и любые приватные данные.",
    `Публичный контекст: ${JSON.stringify(publicContext)}`,
    `Тема: ${topic || "нейроотличность и бережная запись на консультацию"}`,
    `Тон: ${tone || "спокойный, структурный, без обещаний лечения"}`,
    "Верни JSON: {\"title\":string,\"summary\":string,\"bodyMarkdown\":string,\"tags\":string[],\"seoTitle\":string,\"seoDescription\":string}"
  ].join("\n\n");
  let parsed: Partial<SiteArticle> = {};
  try {
    const raw = await answerWithOpenAI(env, articleBotConfig, prompt, { profile: { source: "public_site_article_agent" }, turns: [] });
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    parsed = {
      title: topic || "Как понять, что консультация может быть полезна",
      summary: "Черновик статьи для сайта. Требует ручной проверки перед публикацией.",
      bodyMarkdown:
        "## Черновик\n\nОпишите ситуацию, с которой приходит читатель. Объясните, как проходит консультация, какие данные нужны для записи и почему бот не заменяет экстренную помощь.\n\n## Что важно\n\n- не ставить себе диагноз по статье;\n- записывать только те сведения, которыми человек готов поделиться;\n- обращаться за срочной помощью при риске для жизни или здоровья.",
      tags: ["черновик", "консультация"]
    };
  }
  const article = await upsertSiteArticle(env, normalizeSiteArticleDraft({ ...parsed, status: "draft" }));
  return article;
}

async function updateArticle(env: Env, id: string, patch: Partial<SiteArticle>): Promise<SiteArticle | { error: string }> {
  const articles = await readSiteArticles(env);
  const article = articles.find((item) => item.id === id);
  if (!article) return { error: "not_found" };
  return upsertSiteArticle(env, normalizeSiteArticleDraft({ ...article, ...patch, id: article.id, createdAt: article.createdAt }));
}

async function setArticleStatus(env: Env, id: string, status: "draft" | "published"): Promise<SiteArticle | { error: string }> {
  const articles = await readSiteArticles(env);
  const article = articles.find((item) => item.id === id);
  if (!article) return { error: "not_found" };
  const now = new Date().toISOString();
  const next = { ...article, status, updatedAt: now, publishedAt: status === "published" ? article.publishedAt || now : undefined };
  await writeSiteArticles(env, articles.map((item) => (item.id === id ? next : item)));
  return next;
}

async function uploadArticleCover(request: Request, env: Env, id: string): Promise<Response> {
  const article = (await readSiteArticles(env)).find((item) => item.id === id);
  if (!article) return Response.json({ error: "not_found" }, { status: 404 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.type.startsWith("image/")) return Response.json({ error: "missing_image" }, { status: 400 });
  const key = `site/assets/${crypto.randomUUID()}-${safeFilename(file.name || "cover")}`;
  await writeSiteAsset(env, key, file, file.type);
  const coverImageUrl = `/site/api/assets/${encodeURIComponent(key)}`;
  const next = await upsertSiteArticle(env, { ...article, coverImageKey: key, coverImageUrl, updatedAt: new Date().toISOString() });
  return Response.json(next);
}

async function generateArticleImage(request: Request, env: Env, id: string): Promise<SiteArticle | { error: string; message?: string }> {
  const article = (await readSiteArticles(env)).find((item) => item.id === id);
  if (!article) return { error: "not_found" };
  if (!env.OPENAI_API_KEY) return { error: "openai_image_provider_not_configured" };
  const body = (await request.json().catch(() => ({}))) as { prompt?: string };
  const prompt =
    body.prompt ||
    `Editorial cover image for an article titled "${article.title}". Calm, professional, neurodiversity-informed, no medical claims, no text, no logos.`;
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1536x1024", response_format: "b64_json" }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) return { error: "image_generation_failed", message: (await response.text()).slice(0, 500) };
  const data = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return { error: "image_generation_empty" };
  const key = `site/assets/${crypto.randomUUID()}-generated-cover.png`;
  await writeSiteAsset(env, key, base64ToArrayBuffer(b64), "image/png");
  return upsertSiteArticle(env, { ...article, coverImageKey: key, coverImageUrl: `/site/api/assets/${encodeURIComponent(key)}`, updatedAt: new Date().toISOString() });
}

async function fetchSiteStoredAsset(env: Env, key: string): Promise<Response> {
  if (!env.BOT_OBJECTS) return new Response("r2_required", { status: 404 });
  const object = await env.BOT_OBJECTS.get(key);
  if (!object) return new Response("not_found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400"
    }
  });
}

function publicSession(session: SiteSession, config: SiteConfig): Record<string, unknown> {
  return {
    id: session.id,
    expiresAt: session.expiresAt,
    consentAccepted: hasCurrentConsent(session, config),
    consentVersion: session.consentVersion,
    linkedTelegram: Boolean(session.linkedTelegramChatId),
    name: session.name
  };
}

function json(value: JsonValue | Record<string, unknown>, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const parts = cookie.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function siteChatId(siteSessionId: string): string {
  return `${SITE_CLIENT_PREFIX}${siteSessionId}`;
}

function cleanRequired(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  const cleaned = cleanRequired(value, maxLength);
  return cleaned || undefined;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function firstSentence(value: string): string {
  return value.split(/[.!?\n]/).find((part) => part.trim().length > 20)?.trim() || "";
}

function normalizeTags(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 12);
}

function uniqueSlugPart(value: string): string {
  return value.replace(/^-+|-+$/g, "").slice(0, 120) || `article-${Date.now()}`;
}

function slugifyRu(value: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya"
  };
  return value
    .toLowerCase()
    .split("")
    .map((char) => map[char] ?? char)
    .join("")
    .replace(/[ъь]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
