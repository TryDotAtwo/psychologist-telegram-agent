const DEFAULT_CONFIG = {
  enabled: true,
  webBotEnabled: true,
  brandName: "Карта жизни",
  headline: "Психолог как карта, а не костыль",
  subheadline: "Системно, научно, с нейронками",
  bio: "Психологическая работа для взрослых с РАС/СДВГ: ясно, научно, без давления.",
  telegramUrl: "https://t.me/practicing_autist_bot",
  githubUrl: "https://github.com/TryDotAtwo/psychologist-telegram-agent",
  consentVersion: "2026-06-20",
  consentText:
    "Я даю согласие на обработку данных, которые самостоятельно передаю через сайт: имя или псевдоним, контакт, сообщение в чате, запрос на запись и выбранное время. Данные нужны, чтобы ответить на обращение, записать на консультацию и сохранить понятный контекст диалога.",
  privacyText:
    "Сайт использует техническую cookie на 24 часа. Она содержит только случайный идентификатор и не хранит имя, диагнозы или переписку. Читать сайт и блог можно без согласия. Чат, запись, связь с Telegram и хранение профиля включаются только после явного согласия. Данные не публикуются, не попадают в статьи и нужны только для ответа, записи и сопровождения."
};

const DEFAULT_SERVICES = [
  {
    id: "consultation_60",
    title: "Консультация 60 минут",
    description: "Основная встреча: разбор запроса, карта ситуации, рабочие шаги.",
    durationMinutes: 60
  },
  {
    id: "extended_90",
    title: "Расширенная встреча 90 минут",
    description: "Когда нужно больше времени без спешки и обрыва на середине.",
    durationMinutes: 90
  },
  {
    id: "intro_30",
    title: "Короткая первая связь 30 минут",
    description: "Проверить формат, сформулировать запрос, понять следующий шаг.",
    durationMinutes: 30
  }
];

const DEFAULT_PRICES = [
  { serviceId: "consultation_60", amount: 5000, currency: "₽", note: "Базовая цена за час." },
  { serviceId: "extended_90", amount: 5500, currency: "₽", note: "Час + дополнительные 30 минут." },
  { serviceId: "intro_30", amount: 2500, currency: "₽", note: "Если нужен короткий вход в формат." }
];

const FALLBACK_ARTICLES = [
  {
    slug: "self-instruction",
    title: "Почему инструкция к себе работает лучше советов",
    summary: "Как персональные правила и понятные алгоритмы уменьшают внутренний шум и помогают принимать решения без самонасилия.",
    tags: ["самопонимание", "стратегии", "практика"],
    coverImageUrl: "/site/assets/mask-map-reference.png",
    bodyMarkdown:
      "## Смысл инструкции к себе\n\nСоветы часто звучат красиво, но плохо работают без контекста. Инструкция к себе фиксирует ваш реальный паттерн: что запускает перегрузку, что помогает восстановиться, какие правила снижают хаос.\n\n## Что мы собираем\n\n- триггеры и ранние сигналы;\n- опоры и ограничения;\n- маленькие действия вместо больших обещаний;\n- критерии, по которым понятно, что стратегия работает."
  },
  {
    slug: "autism-adhd-chaos",
    title: "РАС/СДВГ: как снижать хаос без самонасилия",
    summary: "Практические подходы к регулированию, планированию и восстановлению энергии в условиях перегрузки и неопределенности.",
    tags: ["регуляция", "сенсорика", "повседневность"],
    coverImageUrl: "/site/assets/mask-reference.png",
    bodyMarkdown:
      "## Не усиливать давление\n\nЕсли внимание скачет, а сенсорная нагрузка высокая, жесткая дисциплина часто только увеличивает срыв. Рабочая система начинается с наблюдения и снижения лишней нагрузки.\n\n## Практический фокус\n\n- меньше решений в моменте;\n- понятные внешние подсказки;\n- восстановление как часть расписания;\n- правила, которые выдерживают плохой день."
  },
  {
    slug: "masking-energy",
    title: "Маски и энергия: где проходит граница",
    summary: "Почему маски истощают и как распознавать свои настоящие потребности, не теряя контакт с собой.",
    tags: ["маскинг", "границы", "идентичность"],
    coverImageUrl: "/site/assets/face-reference.png",
    bodyMarkdown:
      "## Маска не всегда враг\n\nИногда маска защищает и помогает пройти ситуацию. Проблема начинается, когда она становится единственным способом быть с людьми.\n\n## Что важно заметить\n\n- сколько энергии стоит контакт;\n- где вы соглашаетесь автоматически;\n- какие условия позволяют говорить честнее;\n- что можно изменить маленьким шагом."
  }
];

let siteConfig = { ...DEFAULT_CONFIG };
let services = [...DEFAULT_SERVICES];
let prices = [...DEFAULT_PRICES];
let articles = [...FALLBACK_ARTICLES];
let session = null;
let activePage = "home";
const turnstileTokens = {};
const turnstileWidgetIds = {};

const nodes = {
  pages: [...document.querySelectorAll("[data-page]")],
  brandName: document.querySelector("[data-brand-name]"),
  siteBio: document.querySelector("[data-site-bio]"),
  servicesList: document.getElementById("servicesList"),
  articlesList: document.getElementById("articlesList"),
  articleReader: document.getElementById("articleReader"),
  privacyText: document.getElementById("privacyText"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatText: document.getElementById("chatText"),
  chatStatus: document.getElementById("chatStatus"),
  bookingForm: document.getElementById("bookingForm"),
  bookingService: document.getElementById("bookingService"),
  bookingSlot: document.getElementById("bookingSlot"),
  bookingStatus: document.getElementById("bookingStatus"),
  telegramButton: document.getElementById("createTelegramLink"),
  telegramStatus: document.getElementById("telegramStatus"),
  footerTelegram: document.getElementById("footerTelegram"),
  footerGithub: document.getElementById("footerGithub"),
  consentPanels: [...document.querySelectorAll("[data-consent-panel]")],
  consentTemplate: document.getElementById("consentTemplate")
};

const TITLES = {
  home: "Карта жизни",
  approach: "Как проходит работа",
  about: "О специалисте",
  prices: "Услуги и цены",
  blog: "Блог",
  article: "Статья",
  faq: "FAQ",
  booking: "Запись",
  chat: "Чат",
  contacts: "Контакты",
  privacy: "Данные и согласие"
};

init();

async function init() {
  bindNavigation();
  bindStaticForms();
  await loadSiteConfig();
  await loadArticles();
  renderAll();
  routeToCurrentLocation(false);
  renderTurnstileWhenReady();
}

function bindNavigation() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link) return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/site")) return;
    event.preventDefault();
    history.pushState(null, "", url.pathname + url.search + url.hash);
    routeToCurrentLocation(true);
  });
  window.addEventListener("popstate", () => routeToCurrentLocation(false));
}

function bindStaticForms() {
  nodes.chatForm.addEventListener("submit", sendChatMessage);
  nodes.bookingForm.addEventListener("submit", createBooking);
  nodes.bookingService.addEventListener("change", loadAvailability);
  nodes.telegramButton.addEventListener("click", createTelegramLink);
}

async function loadSiteConfig() {
  try {
    const data = await api("/site/api/config");
    siteConfig = sanitizeConfig(data.config || {});
    services = Array.isArray(data.services) && data.services.length ? data.services : [...DEFAULT_SERVICES];
    prices = Array.isArray(data.prices) && data.prices.length ? data.prices : [...DEFAULT_PRICES];
    session = data.session || null;
  } catch {
    siteConfig = { ...DEFAULT_CONFIG };
    services = [...DEFAULT_SERVICES];
    prices = [...DEFAULT_PRICES];
    session = null;
  }
}

async function loadArticles() {
  try {
    const data = await api("/site/api/articles");
    const published = Array.isArray(data.articles) ? data.articles : [];
    articles = published.length ? published.map(withArticleFallbacks) : [...FALLBACK_ARTICLES];
  } catch {
    articles = [...FALLBACK_ARTICLES];
  }
}

function sanitizeConfig(raw) {
  const next = { ...DEFAULT_CONFIG, ...raw };
  for (const key of ["brandName", "headline", "subheadline", "bio", "consentText", "privacyText"]) {
    next[key] = cleanText(next[key], DEFAULT_CONFIG[key], key);
  }
  next.telegramUrl = raw.telegramUrl || DEFAULT_CONFIG.telegramUrl;
  next.githubUrl = raw.githubUrl || DEFAULT_CONFIG.githubUrl;
  next.webBotEnabled = raw.webBotEnabled !== false;
  next.enabled = raw.enabled !== false;
  return next;
}

function cleanText(value, fallback, key) {
  const text = String(value || "").trim();
  return !text || looksMojibake(text) || looksLegacyDefault(text, key) ? fallback : text;
}

function looksMojibake(text) {
  return /(Рќ|Рџ|РЎ|Рґ|Рё|СЃ|С‚|СЊ|СЏ|СЋ|С‡|С€|В·|В«|В»)/.test(text);
}

function looksLegacyDefault(text, key) {
  const legacy = {
    brandName: [/^НейроПсихолог$/],
    headline: [/^Психологические консультации для нейроотличных взрослых$/],
    subheadline: [/^РАС, СДВГ, перегрузки, адаптация и коммуникация\./],
    bio: [/^Онлайн-консультации для взрослых людей с РАС/],
    consentText: [/^Я понимаю, что при обращении через сайт или бота/],
    privacyText: [/^Сайт и Telegram-бот обрабатывают данные только для ответа/]
  };
  return (legacy[key] || []).some((pattern) => pattern.test(text));
}

function renderAll() {
  document.title = `${TITLES[activePage] || "Карта жизни"} · ${siteConfig.brandName}`;
  nodes.brandName.textContent = siteConfig.brandName || DEFAULT_CONFIG.brandName;
  nodes.siteBio.textContent = siteConfig.bio || DEFAULT_CONFIG.bio;
  setExternalLink(nodes.footerTelegram, siteConfig.telegramUrl);
  setExternalLink(nodes.footerGithub, siteConfig.githubUrl);
  nodes.privacyText.innerHTML = formatLegal(siteConfig.privacyText, siteConfig.consentText);
  renderServices();
  renderArticlesList();
  renderConsentPanels();
  renderConsentState();
}

function routeToCurrentLocation(shouldScroll) {
  const route = routeFromPath(location.pathname);
  activePage = route.page;
  nodes.pages.forEach((page) => page.classList.toggle("is-active", page.dataset.page === route.page));
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const current = link.dataset.nav === (route.page === "article" ? "blog" : route.page);
    link.toggleAttribute("aria-current", current);
  });
  document.title = `${route.title || TITLES[route.page] || "Карта жизни"} · ${siteConfig.brandName}`;
  if (route.page === "article") renderArticleBySlug(route.slug);
  if (route.page === "chat" && session?.consentAccepted) loadChat();
  if (route.page === "booking") loadAvailability();
  renderConsentState();
  renderTurnstileWhenReady();
  if (shouldScroll) window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function routeFromPath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/site";
  if (path === "/site") return { page: "home" };
  if (path === "/site/articles") return { page: "blog" };
  if (path.startsWith("/site/blog/")) {
    const slug = decodeURIComponent(path.slice("/site/blog/".length));
    return { page: "article", slug, title: articleTitle(slug) || "Статья" };
  }
  const page = path.slice("/site/".length);
  if (["approach", "about", "prices", "blog", "faq", "booking", "chat", "contacts", "privacy"].includes(page)) return { page };
  return { page: "home" };
}

function renderServices() {
  nodes.bookingService.innerHTML = services
    .map((service) => `<option value="${escapeAttr(service.id)}">${escapeHtml(service.title)} · ${Number(service.durationMinutes || 60)} мин</option>`)
    .join("");
  nodes.servicesList.innerHTML = services
    .map((service, index) => {
      const price = priceForService(service, index);
      return `
        <article class="service-row">
          <h2>${escapeHtml(service.title)}</h2>
          <p>${escapeHtml(service.description || "Формат и длительность можно уточнить перед записью.")}</p>
          <p><b>${Number(service.durationMinutes || 60)} минут</b></p>
          <p>${escapeHtml(price)}</p>
        </article>
      `;
    })
    .join("");
}

function priceForService(service, index) {
  const price = prices.find((item) => item.serviceId === service.id) || DEFAULT_PRICES[index] || DEFAULT_PRICES[0];
  if (!price) return "Цена уточняется";
  const currency = price.currency === "RUB" ? "₽" : price.currency || "₽";
  const amount = Number(price.amount || 0);
  const value = amount ? `${amount.toLocaleString("ru-RU")} ${currency}` : "Цена уточняется";
  return price.note ? `${value}. ${price.note}` : value;
}

async function loadAvailability() {
  const selected = selectedService();
  const duration = Number(selected?.durationMinutes || 60);
  nodes.bookingSlot.innerHTML = `<option value="">Загружаю свободные окна...</option>`;
  try {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const data = await api(`/site/api/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&durationMinutes=${duration}`);
    const slots = data.availability || [];
    nodes.bookingSlot.innerHTML = slots.length
      ? slots.slice(0, 40).map((slot) => `<option value="${escapeAttr(slot.id)}">${escapeHtml(slotLabel(slot))}</option>`).join("")
      : `<option value="">Свободных окон пока нет</option>`;
  } catch {
    nodes.bookingSlot.innerHTML = `<option value="">Не удалось загрузить окна</option>`;
  }
}

function renderArticlesList() {
  nodes.articlesList.innerHTML = articles.map(articleRow).join("");
}

function articleRow(article, index) {
  const thumb = article.coverImageUrl || FALLBACK_ARTICLES[index % FALLBACK_ARTICLES.length].coverImageUrl;
  return `
    <a class="article-row" href="/site/blog/${encodeURIComponent(article.slug)}" data-link>
      <img src="${escapeAttr(thumb)}" alt="" loading="lazy" />
      <span>
        <span class="article-meta">${escapeHtml((article.tags || []).slice(0, 3).join(" · ") || "практика")}</span>
        <h2>${escapeHtml(article.title)}</h2>
        <p>${escapeHtml(article.summary || "")}</p>
        <span class="article-tags">${(article.tags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</span>
      </span>
      <span class="article-arrow" aria-hidden="true">→</span>
    </a>
  `;
}

async function renderArticleBySlug(slug) {
  let article = articles.find((item) => item.slug === slug);
  if (!article || !article.bodyMarkdown) {
    try {
      const data = await api(`/site/api/articles/${encodeURIComponent(slug)}`);
      article = data.article ? withArticleFallbacks(data.article) : article;
    } catch {
      article = article || null;
    }
  }
  if (!article) {
    nodes.articleReader.innerHTML = `
      <p class="article-meta">/blog</p>
      <h1 id="article-title">Статья не найдена</h1>
      <div class="empty-state">Материал не опубликован или ссылка устарела.</div>
    `;
    return;
  }
  nodes.articleReader.innerHTML = `
    <p class="article-meta">/blog · ${escapeHtml((article.tags || []).join(" · "))}</p>
    <h1 id="article-title">${escapeHtml(article.title)}</h1>
    <div class="markdown-body">${markdownToHtml(article.bodyMarkdown || article.summary || "")}</div>
  `;
}

function articleTitle(slug) {
  return articles.find((item) => item.slug === slug)?.title;
}

function withArticleFallbacks(article, index = 0) {
  return {
    ...article,
    coverImageUrl: article.coverImageUrl || FALLBACK_ARTICLES[index % FALLBACK_ARTICLES.length].coverImageUrl,
    tags: Array.isArray(article.tags) ? article.tags : []
  };
}

function renderConsentPanels() {
  nodes.consentPanels.forEach((panel) => {
    if (session?.consentAccepted) {
      panel.innerHTML = `
        <div class="consent-ready">
          <h2>Согласие принято</h2>
          <p>Доступны чат, запись и связь с Telegram. Технический идентификатор сессии содержит только случайную строку.</p>
          <a class="line-button" href="/site/privacy" data-link>Открыть политику</a>
        </div>
      `;
      return;
    }
    const fragment = nodes.consentTemplate.content.cloneNode(true);
    const form = fragment.querySelector("[data-consent-form]");
    fragment.querySelector("[data-consent-text]").innerHTML = formatLegal(siteConfig.consentText, siteConfig.privacyText);
    form.addEventListener("submit", acceptConsent);
    panel.replaceChildren(fragment);
  });
}

function renderConsentState() {
  const ready = Boolean(session?.consentAccepted);
  const chatEnabled = ready && siteConfig.webBotEnabled;
  nodes.chatText.disabled = !chatEnabled;
  nodes.chatForm.querySelector("button").disabled = !chatEnabled;
  nodes.bookingForm.querySelector("button").disabled = !ready;
  nodes.telegramButton.disabled = !ready;
  if (!ready) {
    nodes.chatLog.innerHTML = `<div class="empty-state">Примите согласие, чтобы начать чат на сайте. Чтение сайта и блога доступно без согласия.</div>`;
    nodes.chatStatus.textContent = "Чат заблокирован до согласия.";
    nodes.bookingStatus.textContent = "Запись заблокирована до согласия.";
    nodes.telegramStatus.textContent = "Связка Telegram заблокирована до согласия.";
  } else {
    nodes.chatStatus.textContent = siteConfig.webBotEnabled ? "" : "Чат временно отключен в панели.";
    if (nodes.bookingStatus.textContent === "Запись заблокирована до согласия.") nodes.bookingStatus.textContent = "";
    if (nodes.telegramStatus.textContent === "Связка Telegram заблокирована до согласия.") nodes.telegramStatus.textContent = "";
  }
}

async function acceptConsent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const accepted = form.querySelector("[data-consent-accepted]").checked;
  const status = form.querySelector("[data-consent-status]");
  if (!accepted) {
    status.textContent = "Нужно явно отметить согласие.";
    return;
  }
  status.textContent = "Сохраняю согласие...";
  try {
    const data = await api("/site/api/consent", {
      method: "POST",
      body: JSON.stringify({
        accepted: true,
        name: form.querySelector("[data-consent-name]").value.trim(),
        contact: form.querySelector("[data-consent-contact]").value.trim()
      })
    });
    session = data.session || session;
    renderConsentPanels();
    renderConsentState();
    renderTurnstileWhenReady();
    if (activePage === "chat") await loadChat();
  } catch {
    status.textContent = "Не удалось сохранить согласие. Попробуйте еще раз.";
  }
}

async function loadChat() {
  try {
    const data = await api("/site/api/chat");
    renderMessages(data.messages || []);
  } catch (error) {
    if (error.status !== 403) nodes.chatStatus.textContent = "Не удалось загрузить историю чата.";
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!session?.consentAccepted) {
    nodes.chatStatus.textContent = "Сначала примите согласие.";
    return;
  }
  const text = nodes.chatText.value.trim();
  if (!text) return;
  nodes.chatText.value = "";
  nodes.chatStatus.textContent = "Отправляю...";
  appendLocalMessage({ role: "user", text, createdAt: new Date().toISOString() });
  try {
    const data = await api("/site/api/chat", {
      method: "POST",
      body: JSON.stringify({ text, turnstileToken: tokenFor("chat") })
    });
    renderMessages(data.messages || []);
    nodes.chatStatus.textContent = "";
    resetTurnstile("chat");
  } catch (error) {
    nodes.chatStatus.textContent = errorMessage(error, "Сообщение не отправлено.");
  }
}

async function createBooking(event) {
  event.preventDefault();
  if (!session?.consentAccepted) {
    nodes.bookingStatus.textContent = "Сначала примите согласие.";
    return;
  }
  const selected = selectedService();
  const availabilityId = nodes.bookingSlot.value;
  if (!availabilityId) {
    nodes.bookingStatus.textContent = "Выберите свободное время.";
    return;
  }
  nodes.bookingStatus.textContent = "Создаю заявку...";
  try {
    const requestText = document.getElementById("bookingRequest").value.trim();
    const data = await api("/site/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        availabilityId,
        serviceId: selected?.id,
        durationMinutes: Number(selected?.durationMinutes || 60),
        name: document.getElementById("bookingName").value.trim(),
        contact: document.getElementById("bookingContact").value.trim(),
        request: [selected?.title ? `Услуга: ${selected.title}` : "", requestText].filter(Boolean).join("\n"),
        turnstileToken: tokenFor("booking")
      })
    });
    nodes.bookingStatus.textContent = data.ok ? "Заявка создана. Психолог подтвердит время." : "Заявка не создана.";
    resetTurnstile("booking");
    await loadAvailability();
    if (activePage === "chat") await loadChat();
  } catch (error) {
    nodes.bookingStatus.textContent = errorMessage(error, "Не удалось создать заявку.");
  }
}

async function createTelegramLink() {
  if (!session?.consentAccepted) {
    nodes.telegramStatus.textContent = "Сначала примите согласие.";
    return;
  }
  nodes.telegramStatus.textContent = "Создаю одноразовую ссылку...";
  try {
    const data = await api("/site/api/telegram-link", {
      method: "POST",
      body: JSON.stringify({ turnstileToken: tokenFor("telegram_link") })
    });
    nodes.telegramStatus.innerHTML = `Ссылка действует до ${escapeHtml(humanDateTime(data.expiresAt))}: <a href="${escapeAttr(data.telegramUrl)}" rel="noopener noreferrer" target="_blank">открыть Telegram</a>`;
    resetTurnstile("telegram_link");
  } catch (error) {
    nodes.telegramStatus.textContent = errorMessage(error, "Не удалось создать Telegram-ссылку.");
  }
}

function renderMessages(messages) {
  nodes.chatLog.innerHTML = messages.length
    ? messages.map(messageMarkup).join("")
    : `<div class="empty-state">Истории пока нет. Напишите первое сообщение.</div>`;
  nodes.chatLog.scrollTop = nodes.chatLog.scrollHeight;
}

function appendLocalMessage(message) {
  const empty = nodes.chatLog.querySelector(".empty-state");
  if (empty) nodes.chatLog.innerHTML = "";
  nodes.chatLog.insertAdjacentHTML("beforeend", messageMarkup({ ...message, source: "local" }));
  nodes.chatLog.scrollTop = nodes.chatLog.scrollHeight;
}

function messageMarkup(message) {
  return `
    <div class="message ${escapeAttr(message.role)} ${escapeAttr(message.source || "")}">
      <p>${escapeHtml(message.text)}</p>
      <time>${escapeHtml(shortDateTime(message.createdAt))}</time>
    </div>
  `;
}

function selectedService() {
  const serviceId = nodes.bookingService.value;
  return services.find((service) => service.id === serviceId) || services[0] || DEFAULT_SERVICES[0];
}

function slotLabel(slot) {
  return `${humanDateTime(slot.startsAt)} — ${shortTime(slot.endsAt)} · ${Number(slot.durationMinutes || 60)} мин`;
}

function renderTurnstileWhenReady(attempt = 0) {
  if (!siteConfig?.turnstileSiteKey) return;
  if (!window.turnstile?.render) {
    if (attempt < 20) setTimeout(() => renderTurnstileWhenReady(attempt + 1), 250);
    return;
  }
  document.querySelectorAll("[data-turnstile-action]").forEach((node) => {
    const action = node.dataset.turnstileAction;
    if (turnstileWidgetIds[action]) return;
    turnstileWidgetIds[action] = window.turnstile.render(node, {
      sitekey: siteConfig.turnstileSiteKey,
      callback: (token) => {
        turnstileTokens[action] = token;
      },
      "expired-callback": () => {
        delete turnstileTokens[action];
      }
    });
  });
}

function resetTurnstile(action) {
  delete turnstileTokens[action];
  const widgetId = turnstileWidgetIds[action];
  if (widgetId !== undefined && window.turnstile?.reset) window.turnstile.reset(widgetId);
}

function tokenFor(action) {
  return siteConfig?.turnstileSiteKey ? turnstileTokens[action] || "" : "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function errorMessage(error, fallback) {
  if (error.status === 403 && error.payload?.error === "consent_required") return "Сначала примите согласие.";
  if (error.status === 403 && String(error.payload?.error || "").startsWith("turnstile")) return "Подтвердите защиту Turnstile и повторите действие.";
  if (error.status === 429) return "Слишком много запросов. Подождите минуту.";
  if (error.status === 409) return "Это окно уже занято или недоступно.";
  return fallback;
}

function setExternalLink(node, href) {
  if (!node) return;
  if (!href) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.href = href;
}

function formatLegal(primary = "", secondary = "") {
  return [primary, secondary]
    .filter(Boolean)
    .map((text) => `<p>${escapeHtml(text).replace(/\n+/g, "</p><p>")}</p>`)
    .join("");
}

function markdownToHtml(markdown) {
  const blocks = String(markdown || "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      if (block.startsWith("### ")) return `<h4>${escapeHtml(block.slice(4))}</h4>`;
      if (block.startsWith("## ")) return `<h3>${escapeHtml(block.slice(3))}</h3>`;
      if (block.startsWith("# ")) return `<h2>${escapeHtml(block.slice(2))}</h2>`;
      if (block.split("\n").every((line) => line.startsWith("- "))) {
        return `<ul>${block.split("\n").map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join("")}</ul>`;
      }
      return `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`;
    })
    .join("");
}

function humanDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function shortTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function shortDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
