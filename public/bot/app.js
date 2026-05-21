let config = null;
let slots = [];
let users = [];
let selectedClientId = null;
let selectedSlotId = null;

const loginScreen = document.getElementById("loginScreen");
const app = document.getElementById("app");
const loginStatus = document.getElementById("loginStatus");
const apiBase = location.pathname.startsWith("/bot") ? "/bot/api" : "/api";

const sectionMeta = {
  overview: ["Обзор", "Состояние бота, запись, клиенты и быстрые действия психолога."],
  clients: ["Клиенты", "История сообщений, карточки клиентов и ручные ответы через Telegram-бота."],
  calendar: ["Календарь", "Свободные окна, удержания, бронирования и Google-синхронизация."],
  prompts: ["Инструкции", "Промпт, память и режим веб-поиска."],
  services: ["Услуги и цены", "Редактирование услуг, длительности, цены и примечаний."],
  google: ["Google", "Подключение аккаунта, календаря и ручная синхронизация."],
  security: ["Безопасность", "Кризисные правила, доступ администратора и границы ответственности."]
};

const headers = () => ({ "Content-Type": "application/json" });

async function api(path, options = {}) {
  const target = path.startsWith("/api") ? `${apiBase}${path.slice(4)}` : path;
  const response = await fetch(target, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function load() {
  setupGoogleLinks();
  [config, slots, users] = await Promise.all([api("/api/config"), api("/api/slots"), api("/api/users").catch(() => [])]);
  renderAll();
  loginScreen.classList.add("hidden");
  app.classList.remove("hidden");
  document.getElementById("saveStatus").textContent = "Данные загружены.";
}

function renderAll() {
  renderConfig();
  renderServices();
  renderPrices();
  renderCalendarBoard();
  renderOverview();
  renderUsers();
  renderCalendarStatus();
}

function setupGoogleLinks() {
  const href = `${apiBase}/auth/google`;
  document.getElementById("loginGoogleLink").href = href;
  document.getElementById("connectGoogleLink").href = href;
}

document.getElementById("loginForm").onsubmit = async (event) => {
  event.preventDefault();
  loginStatus.textContent = "Проверка пароля...";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: document.getElementById("adminPassword").value })
    });
    document.getElementById("adminPassword").value = "";
    await load();
  } catch {
    loginStatus.textContent = "Пароль не подошел.";
  }
};

document.getElementById("logout").onclick = async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  app.classList.add("hidden");
  loginScreen.classList.remove("hidden");
};

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => openSection(button.dataset.section));
});

document.querySelectorAll("[data-section-jump]").forEach((button) => {
  button.addEventListener("click", () => openSection(button.dataset.sectionJump));
});

function openSection(section) {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  document.querySelectorAll("[data-section-panel]").forEach((panel) => {
    panel.classList.toggle("hidden-panel", panel.dataset.sectionPanel !== section);
  });
  const meta = sectionMeta[section] ?? sectionMeta.overview;
  document.getElementById("sectionTitle").textContent = meta[0];
  document.getElementById("sectionSubtitle").textContent = meta[1];
  document.querySelector(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function renderOverview() {
  const freeSlots = slots.filter((slot) => slot.status === "free");
  const riskUsers = users.filter((user) => user.riskLevel === "urgent" || user.riskLevel === "watch");
  document.getElementById("metricClients").textContent = String(users.length);
  document.getElementById("metricSlots").textContent = String(freeSlots.length);
  document.getElementById("metricRisk").textContent = String(riskUsers.length);
  document.getElementById("activityList").innerHTML = users.length
    ? users.slice(0, 6).map((user) => activityRow(user)).join("")
    : `<div class="empty-state">Пока нет диалогов. Когда клиент напишет боту, карточка появится здесь.</div>`;
  attachClientOpenHandlers(document.getElementById("activityList"));
  document.getElementById("overviewSlots").innerHTML = freeSlots.length
    ? freeSlots.slice(0, 6).map((slot) => slotListItem(slot)).join("")
    : `<div class="empty-state">Свободных окон нет. Добавьте окно вручную или обновите Google Calendar.</div>`;
  attachSlotOpenHandlers(document.getElementById("overviewSlots"));
}

function activityRow(user) {
  const name = displayClientName(user);
  return `
    <button class="activity-row" data-client-open="${escapeAttr(user.chatId)}">
      <span><b>${escapeHtml(name)}</b><small>${escapeHtml(user.lastUserText || "Нет текста")}</small></span>
      <em class="risk ${user.riskLevel}">${riskLabel(user.riskLevel)}</em>
    </button>
  `;
}

function renderConfig() {
  document.getElementById("systemPrompt").value = config.systemPrompt || "";
  document.getElementById("crisisPrompt").value = config.crisisPrompt || "";
  document.getElementById("shortTermDays").value = config.memory.shortTermDays;
  document.getElementById("longTermProfileEnabled").checked = config.memory.longTermProfileEnabled;
  document.getElementById("searchEnabled").checked = config.searchEnabled;
}

function collectConfig() {
  config.systemPrompt = document.getElementById("systemPrompt").value;
  config.crisisPrompt = document.getElementById("crisisPrompt").value;
  config.memory.shortTermDays = Number(document.getElementById("shortTermDays").value);
  config.memory.longTermProfileEnabled = document.getElementById("longTermProfileEnabled").checked;
  config.searchEnabled = document.getElementById("searchEnabled").checked;
  config.services = [...document.querySelectorAll("[data-service-row]")].map((row) => ({
    id: row.querySelector("[data-field=id]").value.trim(),
    title: row.querySelector("[data-field=title]").value.trim(),
    durationMinutes: Number(row.querySelector("[data-field=durationMinutes]").value),
    description: row.querySelector("[data-field=description]").value.trim()
  }));
  config.prices = [...document.querySelectorAll("[data-price-row]")].map((row) => ({
    serviceId: row.querySelector("[data-field=serviceId]").value.trim(),
    amount: Number(row.querySelector("[data-field=amount]").value),
    currency: row.querySelector("[data-field=currency]").value.trim(),
    note: row.querySelector("[data-field=note]").value.trim()
  }));
}

function renderServices() {
  const body = document.getElementById("services");
  body.innerHTML = "";
  config.services.forEach((service) => {
    const row = document.createElement("tr");
    row.dataset.serviceRow = "true";
    row.innerHTML = `
      <td data-label="ID"><input data-field="id" value="${escapeAttr(service.id)}"></td>
      <td data-label="Название"><input data-field="title" value="${escapeAttr(service.title)}"></td>
      <td data-label="Длительность"><input data-field="durationMinutes" type="number" min="5" value="${service.durationMinutes}"></td>
      <td data-label="Описание"><input data-field="description" value="${escapeAttr(service.description)}"></td>
    `;
    body.append(row);
  });
}

function renderPrices() {
  const body = document.getElementById("prices");
  body.innerHTML = "";
  config.prices.forEach((price) => {
    const row = document.createElement("tr");
    row.dataset.priceRow = "true";
    row.innerHTML = `
      <td data-label="Услуга"><input data-field="serviceId" value="${escapeAttr(price.serviceId)}"></td>
      <td data-label="Цена"><input data-field="amount" type="number" value="${price.amount}"></td>
      <td data-label="Валюта"><input data-field="currency" value="${escapeAttr(price.currency)}"></td>
      <td data-label="Примечание"><input data-field="note" value="${escapeAttr(price.note)}"></td>
    `;
    body.append(row);
  });
}

function renderCalendarBoard() {
  const board = document.getElementById("calendarBoard");
  const days = buildWeek();
  board.innerHTML = days
    .map((day) => {
      const daySlots = slots
        .filter((slot) => dateKey(slot.startsAt) === day.key)
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      return `
        <section class="day-column">
          <header><b>${escapeHtml(day.weekday)}</b><span>${escapeHtml(day.label)}</span></header>
          <div class="day-slots">
            ${
              daySlots.length
                ? daySlots.map((slot) => slotCard(slot)).join("")
                : `<div class="empty-slot">нет окон</div>`
            }
          </div>
        </section>
      `;
    })
    .join("");
  attachSlotOpenHandlers(board);
  if (!selectedSlotId && slots[0]) selectSlot(slots[0].id);
}

function attachSlotOpenHandlers(root) {
  root.querySelectorAll("[data-slot-open]").forEach((button) => {
    button.addEventListener("click", () => {
      openSection("calendar");
      selectSlot(button.dataset.slotOpen);
    });
  });
}

function buildWeek() {
  const base = slots.length ? new Date(Math.min(...slots.map((slot) => Date.parse(slot.startsAt)))) : new Date();
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() + index);
    return {
      key: dateKey(date.toISOString()),
      weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "Europe/Moscow" }).format(date),
      label: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(date)
    };
  });
}

function slotCard(slot) {
  return `
    <button class="slot-card ${slot.status} ${slot.id === selectedSlotId ? "selected" : ""}" data-slot-open="${escapeAttr(slot.id)}">
      <span>${timeRange(slot)}</span>
      <small>${slotStatusLabel(slot.status)}</small>
    </button>
  `;
}

function selectSlot(slotId) {
  selectedSlotId = slotId;
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) return;
  document.getElementById("slotStart").value = toDateTimeLocal(slot.startsAt);
  document.getElementById("slotEnd").value = toDateTimeLocal(slot.endsAt);
  document.getElementById("slotStatus").value = slot.status;
  document.getElementById("slotSource").value = slot.source;
  document.getElementById("slotEditorStatus").textContent = `Выбрано: ${humanDate(slot.startsAt)}, ${timeRange(slot)}`;
  document.querySelectorAll(".slot-card").forEach((card) => card.classList.toggle("selected", card.dataset.slotOpen === slotId));
}

document.getElementById("applySlot").onclick = () => {
  const slot = slots.find((item) => item.id === selectedSlotId);
  if (!slot) return;
  slot.startsAt = new Date(document.getElementById("slotStart").value).toISOString();
  slot.endsAt = new Date(document.getElementById("slotEnd").value).toISOString();
  slot.status = document.getElementById("slotStatus").value;
  slot.source = slot.source || "manual";
  renderCalendarBoard();
  renderOverview();
  document.getElementById("slotEditorStatus").textContent = "Окно обновлено. Нажмите «Сохранить», чтобы записать изменения.";
};

document.getElementById("addSlot").onclick = () => {
  const start = new Date();
  start.setHours(start.getHours() + 2, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const slot = { id: crypto.randomUUID(), startsAt: start.toISOString(), endsAt: end.toISOString(), status: "free", source: "manual" };
  slots.push(slot);
  selectedSlotId = slot.id;
  renderCalendarBoard();
  renderOverview();
  selectSlot(slot.id);
};

function renderUsers() {
  const list = document.getElementById("clientList");
  list.innerHTML = users.length
    ? users.map((user) => clientRow(user)).join("")
    : `<div class="empty-state">Клиенты появятся после первых сообщений в Telegram.</div>`;
  list.querySelectorAll("[data-client-id]").forEach((button) => {
    button.addEventListener("click", () => selectClient(button.dataset.clientId));
  });
  attachClientOpenHandlers(document);
  if (!selectedClientId && users[0]) selectClient(users[0].chatId);
  else renderClientShell();
}

function attachClientOpenHandlers(root) {
  root.querySelectorAll("[data-client-open]").forEach((button) => {
    button.addEventListener("click", () => {
      openSection("clients");
      selectClient(button.dataset.clientOpen);
    });
  });
}

function clientRow(user) {
  return `
    <button class="client-row ${user.chatId === selectedClientId ? "selected" : ""}" data-client-id="${escapeAttr(user.chatId)}">
      <span><b>${escapeHtml(displayClientName(user))}</b><small>${escapeHtml(user.lastUserText || "Нет сообщений")}</small></span>
      <em class="risk ${user.riskLevel}">${riskLabel(user.riskLevel)}</em>
    </button>
  `;
}

async function selectClient(chatId) {
  selectedClientId = chatId;
  renderUsersSelection();
  renderClientShell();
  const messages = await api(`/api/users/${encodeURIComponent(chatId)}/messages`);
  renderMessages(messages);
}

function renderUsersSelection() {
  document.querySelectorAll("[data-client-id]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.clientId === selectedClientId);
  });
}

function renderClientShell() {
  const user = users.find((item) => item.chatId === selectedClientId);
  if (!user) {
    document.getElementById("clientName").textContent = "Клиент не выбран";
    document.getElementById("clientMeta").textContent = "Выберите диалог слева.";
    document.getElementById("clientRisk").textContent = "нет риска";
    document.getElementById("messageHistory").innerHTML = `<div class="empty-state">История появится после выбора клиента.</div>`;
    return;
  }
  document.getElementById("clientName").textContent = displayClientName(user);
  document.getElementById("clientMeta").textContent = `chat_id=${user.chatId}; сообщений=${user.messageCount}; последнее=${humanDateTime(user.lastMessageAt)}`;
  const risk = document.getElementById("clientRisk");
  risk.textContent = riskLabel(user.riskLevel);
  risk.className = `risk ${user.riskLevel}`;
  document.getElementById("clientTags").value = (user.tags || []).join(", ");
  document.getElementById("clientFacts").value = (user.facts || []).join("\n");
  document.getElementById("clientReminders").value = (user.reminders || []).join("\n");
  document.getElementById("clientNextAction").value = user.nextAction || "";
  document.getElementById("clientRiskSelect").value = user.riskLevel || "none";
}

function renderMessages(messages) {
  document.getElementById("messageHistory").innerHTML = messages.length
    ? messages
        .map(
          (message) => `
            <article class="message ${message.role}">
              <p>${escapeHtml(message.text)}</p>
              <small>${message.role === "user" ? "клиент" : message.source === "admin" ? "психолог" : "бот"} · ${humanDateTime(message.createdAt)}</small>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">История сообщений пока пуста.</div>`;
  const history = document.getElementById("messageHistory");
  history.scrollTop = history.scrollHeight;
}

document.getElementById("replyForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!selectedClientId) return;
  const input = document.getElementById("replyText");
  const text = input.value.trim();
  if (!text) return;
  await api(`/api/users/${encodeURIComponent(selectedClientId)}/reply`, { method: "POST", body: JSON.stringify({ text }) });
  input.value = "";
  users = await api("/api/users");
  await selectClient(selectedClientId);
  renderOverview();
};

document.getElementById("saveClientProfile").onclick = async () => {
  if (!selectedClientId) return;
  const body = {
    tags: splitTags(document.getElementById("clientTags").value),
    facts: splitLines(document.getElementById("clientFacts").value),
    reminders: splitLines(document.getElementById("clientReminders").value),
    nextAction: document.getElementById("clientNextAction").value.trim(),
    riskLevel: document.getElementById("clientRiskSelect").value
  };
  const updated = await api(`/api/users/${encodeURIComponent(selectedClientId)}`, { method: "PUT", body: JSON.stringify(body) });
  users = users.map((user) => (user.chatId === updated.chatId ? updated : user));
  renderOverview();
  renderUsers();
  renderClientShell();
  document.getElementById("clientSaveStatus").textContent = "Карточка сохранена.";
};

document.getElementById("refreshUsers").onclick = async () => {
  users = await api("/api/users");
  renderOverview();
  renderUsers();
};

async function renderCalendarStatus() {
  const status = await api("/api/calendar/status");
  const node = document.getElementById("calendarStatus");
  if (!status.configured) {
    node.innerHTML = `
      <b>Google еще не настроен</b>
      <p>Не хватает секретов: ${escapeHtml((status.missing || []).join(", "))}. Пока бот использует ручные окна из R2.</p>
    `;
    return;
  }
  if (status.connected) {
    node.innerHTML = `
      <b>Календарь подключен</b>
      <p>${status.email ? `Аккаунт: ${escapeHtml(status.email)}. ` : ""}Можно обновлять свободные окна и создавать удержания при записи клиента.</p>
    `;
    return;
  }
  node.innerHTML = `
    <b>Google готов к подключению</b>
    <p>Нажмите «Подключить Google», выберите аккаунт психолога и разрешите доступ к календарю.</p>
  `;
}

async function syncCalendar() {
  const statusNode = document.getElementById("calendarStatus");
  statusNode.innerHTML = `<b>Синхронизация...</b><p>Проверяю занятость календаря и обновляю свободные окна.</p>`;
  const result = await api("/api/calendar/sync", { method: "POST", body: "{}" });
  if (result.ok) {
    slots = await api("/api/slots");
    renderCalendarBoard();
    renderOverview();
    statusNode.innerHTML = `<b>Готово</b><p>Свободные окна обновлены: ${result.slotsWritten || 0}.</p>`;
  } else {
    statusNode.innerHTML = `<b>Синхронизация недоступна</b><p>Причина: ${escapeHtml(result.reason || "unknown")}.</p>`;
  }
}

document.getElementById("syncCalendar").onclick = syncCalendar;
document.getElementById("syncCalendarInline").onclick = syncCalendar;

document.getElementById("addPrice").onclick = () => {
  config.prices.push({ serviceId: "new_service", amount: 0, currency: "RUB", note: "" });
  renderPrices();
};

document.getElementById("addService").onclick = () => {
  config.services.push({ id: "new_service", title: "Новая услуга", durationMinutes: 60, description: "" });
  renderServices();
};

document.getElementById("save").onclick = async () => {
  collectConfig();
  await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
  await api("/api/slots", { method: "PUT", body: JSON.stringify(slots) });
  document.getElementById("saveStatus").textContent = `Сохранено: ${new Date().toLocaleString("ru-RU")}`;
};

document.getElementById("reset").onclick = () => load();
document.getElementById("preview").onclick = () => openSection("clients");

function slotListItem(slot) {
  return `<button class="slot-list-item" data-slot-open="${escapeAttr(slot.id)}"><span>${humanDate(slot.startsAt)}</span><b>${timeRange(slot)}</b><small>${slotStatusLabel(slot.status)}</small></button>`;
}

function displayClientName(user) {
  if (user.firstName || user.lastName) return `${user.firstName || ""} ${user.lastName || ""}`.trim();
  if (user.username) return `@${user.username}`;
  return `Клиент ${user.chatId}`;
}

function riskLabel(value) {
  return value === "urgent" ? "срочно" : value === "watch" ? "наблюдать" : "нет риска";
}

function slotStatusLabel(value) {
  return value === "booked" ? "занято" : value === "held" ? "удержано" : "свободно";
}

function timeRange(slot) {
  const format = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return `${format.format(new Date(slot.startsAt))}-${format.format(new Date(slot.endsAt))}`;
}

function humanDate(value) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function humanDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

function dateKey(value) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function toDateTimeLocal(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function splitTags(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function splitLines(value) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

api("/api/session")
  .then((session) => (session.authenticated ? load() : Promise.reject(new Error("anonymous"))))
  .catch(() => {
    setupGoogleLinks();
    app.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  });
