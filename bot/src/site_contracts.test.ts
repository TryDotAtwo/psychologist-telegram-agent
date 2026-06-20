import type { SiteArticle, SiteConfig, SiteSession } from "./types";
import {
  SITE_SESSION_COOKIE,
  SITE_SESSION_TTL_MS,
  buildSiteSessionCookie,
  consentRequired,
  normalizeSiteArticleDraft,
  publicArticle,
  publicSiteConfig,
  siteSessionExpired
} from "./site";

const now = new Date("2026-06-20T12:00:00.000Z");

const session: SiteSession = {
  id: "site_session_123",
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + SITE_SESSION_TTL_MS).toISOString(),
  consentVersion: "2026-06-20",
  consentAcceptedAt: now.toISOString()
};

const cookie = buildSiteSessionCookie(session.id, session.expiresAt);
if (!cookie.includes(`${SITE_SESSION_COOKIE}=${session.id}`)) throw new Error("site session cookie must carry only opaque id");
if (!cookie.includes("HttpOnly")) throw new Error("site session cookie must be HttpOnly");
if (!cookie.includes("Secure")) throw new Error("site session cookie must be Secure");
if (!cookie.includes("SameSite=Lax")) throw new Error("site session cookie must use SameSite=Lax");
if (!cookie.includes("Max-Age=86400")) throw new Error("site session cookie must expire in 24h");
if (siteSessionExpired(session, now)) throw new Error("fresh site session must not be expired");
if (consentRequired(session)) throw new Error("accepted current consent must unlock site flows");

const config: SiteConfig = {
  enabled: true,
  webBotEnabled: true,
  brandName: "НейроПсихолог",
  headline: "Психологические консультации для нейроотличных взрослых",
  subheadline: "Прямо, структурно, без эзотерики.",
  bio: "Работа с РАС, СДВГ и похожей нейроотличной сборкой.",
  telegramUrl: "https://t.me/practicing_autist_bot",
  githubUrl: "https://github.com/TryDotAtwo/psychologist-telegram-agent",
  consentVersion: "2026-06-20",
  consentText: "Я понимаю, какие данные обрабатываются и зачем.",
  privacyText: "Описание обработки данных.",
  articleAgentInstructions: "Писать спокойно и бережно.",
  turnstileSiteKey: "1x00000000000000000000AA"
};

const publicConfig = publicSiteConfig(config);
if ("articleAgentInstructions" in publicConfig) throw new Error("public config must not expose article agent instructions");

const draft = normalizeSiteArticleDraft({
  title: "  Новый материал про запись  ",
  bodyMarkdown: "Текст статьи",
  tags: ["РАС", "РАС", "СДВГ"],
  status: "draft"
});
if (draft.slug !== "novyy-material-pro-zapis") throw new Error(`unexpected slug: ${draft.slug}`);
if (draft.tags.length !== 2) throw new Error("article tags must be normalized");

const article: SiteArticle = {
  id: "article_1",
  slug: "test",
  title: "Публичная статья",
  summary: "Кратко",
  bodyMarkdown: "Полный текст",
  status: "published",
  tags: ["РАС"],
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  publishedAt: now.toISOString()
};

const exposed = publicArticle(article);
if (exposed.status !== "published") throw new Error("published article should expose status");
// @ts-expect-error public article shape must never expose internal ids.
exposed.id;
// @ts-expect-error public article shape must never expose internal R2 object keys.
exposed.coverImageKey;
