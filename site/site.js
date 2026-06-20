let siteConfig = null;
let services = [];
let prices = [];
let articles = [];
let session = null;
const turnstileTokens = {};
const turnstileWidgetIds = {};

const nodes = {
  brandName: document.getElementById("brandName"),
  footerBrand: document.getElementById("footerBrand"),
  headline: document.getElementById("siteHeadline"),
  subheadline: document.getElementById("siteSubheadline"),
  bio: document.getElementById("siteBio"),
  githubLink: document.getElementById("githubLink"),
  footerGithub: document.getElementById("footerGithub"),
  footerTelegram: document.getElementById("footerTelegram"),
  servicesList: document.getElementById("servicesList"),
  consentForm: document.getElementById("consentForm"),
  consentReady: document.getElementById("consentReady"),
  consentText: document.getElementById("consentText"),
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
  articlesList: document.getElementById("articlesList"),
  articleReader: document.getElementById("articleReader")
};

init();

async function init() {
  bindHandlers();
  await loadSite();
  await loadArticles();
  if (session?.consentAccepted) await loadChat();
  renderSelectedArticleFromPath();
  renderTurnstileWhenReady();
}

function bindHandlers() {
  nodes.consentForm.addEventListener("submit", acceptConsent);
  nodes.chatForm.addEventListener("submit", sendChatMessage);
  nodes.bookingForm.addEventListener("submit", createBooking);
  nodes.bookingService.addEventListener("change", loadAvailability);
  nodes.telegramButton.addEventListener("click", createTelegramLink);
}

async function loadSite() {
  const data = await api("/site/api/config");
  siteConfig = data.config || {};
  services = data.services || [];
  prices = data.prices || [];
  session = data.session || {};
  document.title = siteConfig.brandName || "НейроПсихолог";
  nodes.brandName.textContent = siteConfig.brandName || "НейроПсихолог";
  nodes.footerBrand.textContent = siteConfig.brandName || "НейроПсихолог";
  nodes.headline.textContent = siteConfig.headline || "Психологическая консультация";
  nodes.subheadline.textContent = siteConfig.subheadline || "";
  nodes.bio.textContent = siteConfig.bio || "";
  setLink(nodes.githubLink, siteConfig.githubUrl, "GitHub проекта");
  setLink(nodes.footerGithub, siteConfig.githubUrl, "GitHub");
  setLink(nodes.footerTelegram, siteConfig.telegramUrl, "Telegram");
  nodes.consentText.innerHTML = formatLegal(siteConfig.consentText, siteConfig.privacyText);
  nodes.privacyText.innerHTML = formatLegal(siteConfig.privacyText, siteConfig.consentText);
  renderServices();
  renderConsentState();
  await loadAvailability();
}

async function loadArticles() {
  const data = await api("/site/api/articles");
  articles = data.articles || [];
  nodes.articlesList.innerHTML = articles.length
    ? articles.map(articleCard).join("")
    : `<div class="empty-state">Опубликованных статей пока нет.</div>`;
  nodes.articlesList.querySelectorAll("[data-article-slug]").forEach((button) => {
    button.addEventListener("click", () => openArticle(button.dataset.articleSlug));
  });
}

function renderServices() {
  nodes.bookingService.innerHTML = services.length
    ? services.map((service) => `<option value="${escapeAttr(service.id)}">${escapeHtml(service.title)} · ${Number(service.durationMinutes || 30)} мин</option>`).join("")
    : `<option value="consultation">Консультация · 30 мин</option>`;
  nodes.servicesList.innerHTML = services.length
    ? services.map((service) => {
        const price = prices.find((item) => item.serviceId === service.id);
        const priceText = price ? `${Number(price.amount || 0).toLocaleString("ru-RU")} ${escapeHtml(price.currency || "RUB")}` : "Цена уточняется";
        return `
          <article class="service-card">
            <h3>${escapeHtml(service.title)}</h3>
            <p>${escapeHtml(service.description || "")}</p>
            <dl>
              <div><dt>Длительность</dt><dd>${Number(service.durationMinutes || 30)} мин</dd></div>
              <div><dt>Цена</dt><dd>${priceText}</dd></div>
            </dl>
            ${price?.note ? `<small>${escapeHtml(price.note)}</small>` : ""}
          </article>
        `;
      }).join("")
    : `<div class="empty-state">Услуги еще не опубликованы в dashboard.</div>`;
}

function renderConsentState() {
  const ready = Boolean(session?.consentAccepted);
  nodes.consentForm.classList.toggle("hidden", ready);
  nodes.consentReady.classList.toggle("hidden", !ready);
  nodes.chatText.disabled = !ready || !siteConfig.webBotEnabled;
  nodes.chatForm.querySelector("button").disabled = !ready || !siteConfig.webBotEnabled;
  nodes.bookingForm.querySelector("button").disabled = !ready;
  nodes.telegramButton.disabled = !ready;
  if (!ready) {
    nodes.chatLog.innerHTML = `<div class="empty-state">Примите согласие, чтобы начать web-chat.</div>`;
    nodes.chatStatus.textContent = "Чат заблокирован до согласия.";
    nodes.bookingStatus.textContent = "Запись заблокирована до согласия.";
    nodes.telegramStatus.textContent = "Связка Telegram заблокирована до согласия.";
  } else {
    nodes.chatStatus.textContent = siteConfig.webBotEnabled ? "" : "Web-chat временно отключен в dashboard.";
    nodes.bookingStatus.textContent = "";
    nodes.telegramStatus.textContent = "";
  }
}

async function acceptConsent(event) {
  event.preventDefault();
  const accepted = document.getElementById("consentAccepted").checked;
  if (!accepted) {
    document.getElementById("consentStatus").textContent = "Нужно явно отметить согласие.";
    return;
  }
  const data = await api("/site/api/consent", {
    method: "POST",
    body: JSON.stringify({
      accepted: true,
      name: document.getElementById("consentName").value.trim(),
      contact: document.getElementById("consentContact").value.trim()
    })
  });
  session = data.session;
  document.getElementById("consentStatus").textContent = "Согласие сохранено.";
  renderConsentState();
  await loadChat();
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

async function loadAvailability() {
  const selected = selectedService();
  const duration = Number(selected?.durationMinutes || 30);
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const data = await api(`/site/api/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&durationMinutes=${duration}`);
  const slots = data.availability || [];
  nodes.bookingSlot.innerHTML = slots.length
    ? slots.slice(0, 40).map((slot) => `<option value="${escapeAttr(slot.id)}">${escapeHtml(slotLabel(slot))}</option>`).join("")
    : `<option value="">Свободных окон нет</option>`;
}

async function createBooking(event) {
  event.preventDefault();
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
        durationMinutes: Number(selected?.durationMinutes || 30),
        name: document.getElementById("bookingName").value.trim(),
        contact: document.getElementById("bookingContact").value.trim(),
        request: [selected?.title ? `Услуга: ${selected.title}` : "", requestText].filter(Boolean).join("\n"),
        turnstileToken: tokenFor("booking")
      })
    });
    nodes.bookingStatus.textContent = data.ok ? "Заявка создана. Психолог подтвердит время." : "Заявка не создана.";
    resetTurnstile("booking");
    await loadAvailability();
    if (session?.consentAccepted) await loadChat();
  } catch (error) {
    nodes.bookingStatus.textContent = errorMessage(error, "Не удалось создать заявку.");
  }
}

async function createTelegramLink() {
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

function selectedService() {
  const serviceId = nodes.bookingService.value;
  return services.find((service) => service.id === serviceId) || services[0] || { id: "consultation", title: "Консультация", durationMinutes: 30 };
}

function renderMessages(messages) {
  nodes.chatLog.innerHTML = messages.length
    ? messages.map((message) => `
      <div class="message ${escapeAttr(message.role)} ${escapeAttr(message.source || "")}">
        <p>${escapeHtml(message.text)}</p>
        <time>${escapeHtml(shortDateTime(message.createdAt))}</time>
      </div>
    `).join("")
    : `<div class="empty-state">Истории пока нет. Напишите первое сообщение.</div>`;
  nodes.chatLog.scrollTop = nodes.chatLog.scrollHeight;
}

function appendLocalMessage(message) {
  const empty = nodes.chatLog.querySelector(".empty-state");
  if (empty) nodes.chatLog.innerHTML = "";
  nodes.chatLog.insertAdjacentHTML("beforeend", `
    <div class="message ${escapeAttr(message.role)} local">
      <p>${escapeHtml(message.text)}</p>
      <time>${escapeHtml(shortDateTime(message.createdAt))}</time>
    </div>
  `);
  nodes.chatLog.scrollTop = nodes.chatLog.scrollHeight;
}

function articleCard(article) {
  return `
    <article class="article-card">
      ${article.coverImageUrl ? `<img src="${escapeAttr(article.coverImageUrl)}" alt="" loading="lazy" />` : ""}
      <div>
        <h3>${escapeHtml(article.title)}</h3>
        <p>${escapeHtml(article.summary || "")}</p>
        <button type="button" data-article-slug="${escapeAttr(article.slug)}">Читать</button>
      </div>
    </article>
  `;
}

async function openArticle(slug) {
  const data = await api(`/site/api/articles/${encodeURIComponent(slug)}`);
  renderArticle(data.article);
  history.pushState(null, "", `/articles/${encodeURIComponent(slug)}`);
}

function renderSelectedArticleFromPath() {
  const match = location.pathname.match(/^\/articles\/([^/]+)$/);
  if (match) openArticle(decodeURIComponent(match[1])).catch(() => {});
}

function renderArticle(article) {
  if (!article) return;
  nodes.articleReader.classList.remove("hidden");
  nodes.articleReader.innerHTML = `
    ${article.coverImageUrl ? `<img class="article-cover" src="${escapeAttr(article.coverImageUrl)}" alt="" />` : ""}
    <p class="eyebrow">${escapeHtml((article.tags || []).join(" · "))}</p>
    <h2>${escapeHtml(article.title)}</h2>
    <div class="markdown-body">${markdownToHtml(article.bodyMarkdown || "")}</div>
  `;
  nodes.articleReader.scrollIntoView({ behavior: "smooth", block: "start" });
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

function setLink(node, href, label) {
  if (!href) {
    node.classList.add("hidden");
    return;
  }
  node.classList.remove("hidden");
  node.href = href;
  node.textContent = label;
}

function slotLabel(slot) {
  return `${humanDateTime(slot.startsAt)} · ${shortTime(slot.endsAt)} · ${Number(slot.durationMinutes || 30)} мин`;
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

function formatLegal(primary = "", secondary = "") {
  return [primary, secondary].filter(Boolean).map((text) => `<p>${escapeHtml(text).replace(/\n+/g, "</p><p>")}</p>`).join("");
}

function markdownToHtml(markdown) {
  const blocks = String(markdown || "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => {
    if (block.startsWith("### ")) return `<h4>${escapeHtml(block.slice(4))}</h4>`;
    if (block.startsWith("## ")) return `<h3>${escapeHtml(block.slice(3))}</h3>`;
    if (block.startsWith("# ")) return `<h2>${escapeHtml(block.slice(2))}</h2>`;
    if (block.split("\n").every((line) => line.startsWith("- "))) {
      return `<ul>${block.split("\n").map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`;
  }).join("");
}

function errorMessage(error, fallback) {
  if (error.status === 403 && error.payload?.error === "consent_required") return "Сначала примите согласие.";
  if (error.status === 403 && error.payload?.error?.startsWith("turnstile")) return "Подтвердите защиту Turnstile и повторите действие.";
  if (error.status === 429) return "Слишком много запросов. Подождите минуту.";
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
