let config = null;
let schedule = null;
let availability = [];
let busy = [];
let bookings = [];
let users = [];
let reminders = [];
let selectedClientId = null;
let selectedAvailabilityId = null;

const loginScreen = document.getElementById("loginScreen");
const app = document.getElementById("app");
const loginStatus = document.getElementById("loginStatus");
const apiBase = location.pathname.startsWith("/bot") ? "/bot/api" : "/api";

const weekdays = [
  ["mon", "Пн"],
  ["tue", "Вт"],
  ["wed", "Ср"],
  ["thu", "Чт"],
  ["fri", "Пт"],
  ["sat", "Сб"],
  ["sun", "Вс"]
];

const sectionMeta = {
  overview: ["Обзор", "Рабочая очередь, ближайшие записи и состояние бота."],
  clients: ["Клиенты", "История сообщений, профиль клиента, напоминания и ответы через Telegram."],
  calendar: ["Календарь", "Рабочие часы, свободные окна, занятость Google и бронирования."],
  prompts: ["Инструкции", "Промпт, память и режим веб-поиска."],
  services: ["Услуги", "Услуги, длительность, цены и примечания."],
  google: ["Google", "Подключение аккаунта, календаря и синхронизация занятости."],
  security: ["Безопасность", "Кризисные правила, доступ и границы ответственности."]
};

initTheme();
setupStaticHandlers();
setupGoogleLinks();
checkSession();

function headers() {
  return { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const target = path.startsWith("/api") ? `${apiBase}${path.slice(4)}` : path;
  const response = await fetch(target, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function checkSession() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await load();
  } catch {
    loginScreen.classList.remove("hidden");
  }
}

async function load() {
  setupGoogleLinks();
  const duration = Number(document.getElementById("availabilityDuration")?.value || 30);
  [config, schedule, users, bookings, reminders] = await Promise.all([
    api("/api/config"),
    api("/api/calendar/schedule"),
    api("/api/users").catch(() => []),
    api("/api/calendar/bookings").catch(() => []),
    api("/api/reminders").catch(() => [])
  ]);
  await loadAvailability(duration);
  renderAll();
  loginScreen.classList.add("hidden");
  app.classList.remove("hidden");
  document.getElementById("saveStatus").textContent = "Данные загружены.";
}

async function loadAvailability(duration = 30) {
  const from = new Date();
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const result = await api(`/api/calendar/availability?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&durationMinutes=${duration}`);
  availability = result.availability || [];
  busy = result.busy || [];
}

function renderAll() {
  renderConfig();
  renderServices();
  renderPrices();
  renderWeeklySchedule();
  renderCalendarBoard();
  renderOverview();
  renderUsers();
  renderCalendarStatus();
  renderClient();
}

function setupGoogleLinks() {
  const href = `${apiBase}/auth/google`;
  document.getElementById("loginGoogleLink").href = href;
  document.getElementById("connectGoogleLink").href = href;
}

function setupStaticHandlers() {
  document.getElementById("loginForm").onsubmit = async (event) => {
    event.preventDefault();
    loginStatus.textContent = "Проверка пароля...";
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: document.getElementById("adminPassword").value }) });
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

  document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => openSection(button.dataset.section)));
  document.querySelectorAll("[data-section-jump]").forEach((button) => button.addEventListener("click", () => openSection(button.dataset.sectionJump)));
  document.getElementById("drawerToggle").onclick = toggleDrawer;
  document.getElementById("drawerBackdrop").onclick = closeMobileDrawer;
  document.getElementById("themeToggle").onclick = toggleTheme;
  document.getElementById("preview").onclick = () => openSection("clients");
  document.getElementById("save").onclick = saveConfig;
  document.getElementById("reset").onclick = load;
  document.getElementById("saveSchedule").onclick = saveSchedule;
  document.getElementById("applyOverride").onclick = applyDateOverride;
  document.getElementById("refreshAvailability").onclick = async () => {
    await loadAvailability(Number(document.getElementById("availabilityDuration").value || 30));
    renderCalendarBoard();
    renderOverview();
  };
  document.getElementById("manualBook").onclick = manualBookSelected;
  document.getElementById("syncCalendar").onclick = syncCalendar;
  document.getElementById("syncCalendarInline").onclick = syncCalendar;
  document.getElementById("refreshUsers").onclick = async () => {
    users = await api("/api/users");
    reminders = await api("/api/reminders");
    renderUsers();
    renderClient();
  };
  document.getElementById("replyForm").onsubmit = sendReply;
  document.getElementById("saveClientProfile").onclick = saveClientProfile;
  document.getElementById("addReminder").onclick = addManualReminder;
  document.getElementById("addService").onclick = addService;
  document.getElementById("addPrice").onclick = addPrice;
}

function initTheme() {
  const saved = localStorage.getItem("dashboard-theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("dashboard-theme", next);
}

function toggleDrawer() {
  if (innerWidth <= 900) app.classList.toggle("drawer-open");
  else app.classList.toggle("drawer-collapsed");
}

function closeMobileDrawer() {
  app.classList.remove("drawer-open");
}

function openSection(section) {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  document.querySelectorAll("[data-section-panel]").forEach((panel) => panel.classList.toggle("hidden-panel", panel.dataset.sectionPanel !== section));
  const meta = sectionMeta[section] || sectionMeta.overview;
  document.getElementById("sectionTitle").textContent = meta[0];
  document.getElementById("sectionSubtitle").textContent = meta[1];
  document.querySelector(".workspace").scrollTo({ top: 0, behavior: "smooth" });
  closeMobileDrawer();
}

function renderOverview() {
  const scheduledReminders = reminders.filter((reminder) => reminder.status === "scheduled");
  const riskUsers = users.filter((user) => user.riskLevel === "urgent" || user.riskLevel === "watch");
  document.getElementById("metricClients").textContent = String(users.length);
  document.getElementById("metricAvailability").textContent = String(availability.length);
  document.getElementById("metricReminders").textContent = String(scheduledReminders.length);
  document.getElementById("activityList").innerHTML = users.length
    ? users.slice(0, 6).map((user) => activityRow(user)).join("")
    : `<div class="empty-state">Пока нет диалогов. Когда клиент напишет боту, карточка появится здесь.</div>`;
  attachClientOpenHandlers(document.getElementById("activityList"));
  document.getElementById("overviewAvailability").innerHTML = availability.length
    ? availability.slice(0, 6).map((slot) => availabilityListItem(slot)).join("")
    : `<div class="empty-state">Свободных окон нет. Проверьте рабочие часы или Google Calendar.</div>`;
  attachAvailabilityHandlers(document.getElementById("overviewAvailability"));
  if (riskUsers.length) document.getElementById("sidebarStatus").textContent = `Требуют внимания: ${riskUsers.length}`;
}

function activityRow(user) {
  return `
    <button class="activity-row" data-client-open="${escapeAttr(user.chatId)}">
      <span><b>${escapeHtml(displayClientName(user))}</b><small>${escapeHtml(user.lastUserText || "Нет текста")}</small></span>
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
    currency: row.querySelector("[data-field=currency]").value.trim() || "RUB",
    note: row.querySelector("[data-field=note]").value.trim()
  }));
}

async function saveConfig() {
  collectConfig();
  await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
  document.getElementById("saveStatus").textContent = "Конфигурация сохранена.";
}

function renderServices() {
  document.getElementById("services").innerHTML = config.services.map((service) => `
    <tr data-service-row>
      <td data-label="ID"><input data-field="id" value="${escapeAttr(service.id)}" /></td>
      <td data-label="Название"><input data-field="title" value="${escapeAttr(service.title)}" /></td>
      <td data-label="Длительность"><input data-field="durationMinutes" type="number" min="5" value="${service.durationMinutes}" /></td>
      <td data-label="Описание"><input data-field="description" value="${escapeAttr(service.description)}" /></td>
    </tr>
  `).join("");
}

function renderPrices() {
  document.getElementById("prices").innerHTML = config.prices.map((price) => `
    <tr data-price-row>
      <td data-label="Услуга"><input data-field="serviceId" value="${escapeAttr(price.serviceId)}" /></td>
      <td data-label="Цена"><input data-field="amount" type="number" min="0" value="${price.amount}" /></td>
      <td data-label="Валюта"><input data-field="currency" value="${escapeAttr(price.currency)}" /></td>
      <td data-label="Примечание"><input data-field="note" value="${escapeAttr(price.note)}" /></td>
    </tr>
  `).join("");
}

function addService() {
  collectConfig();
  config.services.push({ id: `service_${config.services.length + 1}`, title: "Новая услуга", durationMinutes: 60, description: "" });
  renderServices();
}

function addPrice() {
  collectConfig();
  config.prices.push({ serviceId: config.services[0]?.id || "service", amount: 0, currency: "RUB", note: "" });
  renderPrices();
}

function renderWeeklySchedule() {
  const root = document.getElementById("weeklySchedule");
  root.innerHTML = weekdays.map(([key, label]) => {
    const windows = schedule.weeklyTemplate[key] || [];
    return `
      <article class="schedule-day" data-weekday="${key}">
        <h3>${label}</h3>
        <label>Рабочие часы<input data-schedule-windows value="${escapeAttr(formatWindows(windows))}" placeholder="12:00-20:00" /></label>
      </article>
    `;
  }).join("");
}

async function saveSchedule() {
  for (const [key] of weekdays) {
    const input = document.querySelector(`[data-weekday="${key}"] [data-schedule-windows]`);
    schedule.weeklyTemplate[key] = parseWindows(input.value);
  }
  schedule.slotStepMinutes = 30;
  schedule.introDurationMinutes = 30;
  schedule.defaultSessionMinutes = Number(document.getElementById("clientDuration").value || schedule.defaultSessionMinutes || 60);
  schedule = await api("/api/calendar/schedule", { method: "PUT", body: JSON.stringify(schedule) });
  await loadAvailability(Number(document.getElementById("availabilityDuration").value || 30));
  renderCalendarBoard();
  renderOverview();
  document.getElementById("saveStatus").textContent = "Рабочие часы сохранены.";
}

async function applyDateOverride() {
  const date = document.getElementById("overrideDate").value;
  if (!date) return;
  const closed = document.getElementById("overrideClosed").checked;
  const windows = parseWindows(document.getElementById("overrideWindows").value);
  schedule.dateOverrides[date] = { closed, windows, note: closed ? "Выходной" : "Индивидуальные часы" };
  schedule = await api("/api/calendar/schedule", { method: "PUT", body: JSON.stringify(schedule) });
  await loadAvailability(Number(document.getElementById("availabilityDuration").value || 30));
  renderCalendarBoard();
  document.getElementById("saveStatus").textContent = "Исключение для даты сохранено.";
}

function renderCalendarBoard() {
  const board = document.getElementById("calendarBoard");
  const days = nextDays(7);
  const items = [
    ...availability.map((slot) => ({ ...slot, type: "free", dateKey: dateKey(slot.startsAt), sortAt: slot.startsAt })),
    ...busy.map((item) => ({ ...item, type: "busy", dateKey: dateKey(item.startsAt), sortAt: item.startsAt }))
  ];
  board.innerHTML = days.map((day) => {
    const dayItems = items.filter((item) => item.dateKey === day.key).sort((a, b) => Date.parse(a.sortAt) - Date.parse(b.sortAt));
    return `
      <section class="day-column">
        <header><b>${day.weekday}</b><span>${day.label}</span></header>
        <div class="day-slots">
          ${dayItems.length ? dayItems.map(calendarItem).join("") : `<div class="empty-state">Нет рабочих окон</div>`}
        </div>
      </section>
    `;
  }).join("");
  attachAvailabilityHandlers(board);
  renderBookings();
}

function calendarItem(item) {
  if (item.type === "busy") {
    return `<div class="slot-card busy"><span>${timeRange(item)}</span><small>Занято: ${escapeHtml(item.title || item.source || "Google")}</small></div>`;
  }
  return `
    <button class="slot-card ${item.id === selectedAvailabilityId ? "selected" : ""}" data-availability-id="${escapeAttr(item.id)}">
      <span>${timeRange(item)}</span>
      <small>Свободно на ${item.durationMinutes} мин</small>
    </button>
  `;
}

function attachAvailabilityHandlers(root) {
  root.querySelectorAll("[data-availability-id]").forEach((button) => {
    button.addEventListener("click", () => selectAvailability(button.dataset.availabilityId));
  });
}

function selectAvailability(id) {
  selectedAvailabilityId = id;
  const slot = availability.find((item) => item.id === id);
  document.getElementById("slotEditorStatus").textContent = slot ? `${humanDate(slot.startsAt)}, ${timeRange(slot)}` : "Окно не найдено.";
  document.querySelectorAll(".slot-card").forEach((card) => card.classList.toggle("selected", card.dataset.availabilityId === id));
}

async function manualBookSelected() {
  const slot = availability.find((item) => item.id === selectedAvailabilityId);
  if (!slot) return;
  const clientName = document.getElementById("bookingClient").value.trim();
  const booking = await api("/api/calendar/bookings", {
    method: "POST",
    body: JSON.stringify({ availabilityId: slot.id, durationMinutes: slot.durationMinutes, clientName })
  });
  bookings.push(booking);
  await loadAvailability(Number(document.getElementById("availabilityDuration").value || 30));
  selectedAvailabilityId = null;
  renderCalendarBoard();
}

function renderBookings() {
  const active = bookings.filter((booking) => booking.status !== "cancelled").slice(0, 12);
  document.getElementById("bookingList").innerHTML = active.length
    ? active.map((booking) => `<div class="booking-item"><span><b>${humanDate(booking.startsAt)}</b><small>${timeRange(booking)} · ${escapeHtml(booking.clientName || booking.chatId || "ручная запись")}</small></span><em class="status-pill busy">${booking.status}</em></div>`).join("")
    : `<div class="empty-state">Бронирований пока нет.</div>`;
}

function renderUsers() {
  document.getElementById("clientList").innerHTML = users.length
    ? users.map((user) => `
      <button class="client-row ${user.chatId === selectedClientId ? "selected" : ""}" data-client-open="${escapeAttr(user.chatId)}">
        <span><b>${escapeHtml(displayClientName(user))}</b><small>${escapeHtml(user.lastUserText || "Нет текста")}</small></span>
        <em class="risk ${user.riskLevel}">${riskLabel(user.riskLevel)}</em>
      </button>
    `).join("")
    : `<div class="empty-state">Клиенты появятся после первых сообщений в Telegram.</div>`;
  attachClientOpenHandlers(document.getElementById("clientList"));
  if (!selectedClientId && users[0]) selectedClientId = users[0].chatId;
}

function attachClientOpenHandlers(root) {
  root.querySelectorAll("[data-client-open]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedClientId = button.dataset.clientOpen;
      openSection("clients");
      renderUsers();
      renderClient();
    });
  });
}

async function renderClient() {
  const user = users.find((item) => item.chatId === selectedClientId);
  if (!user) {
    document.getElementById("clientName").textContent = "Клиент не выбран";
    document.getElementById("clientSummary").innerHTML = "";
    document.getElementById("messageHistory").innerHTML = `<div class="empty-state">Выберите клиента слева.</div>`;
    return;
  }
  const profile = mergedProfile(user);
  document.getElementById("clientName").textContent = displayClientName(user);
  document.getElementById("clientMeta").textContent = `chat_id=${user.chatId}; сообщений=${user.messageCount}`;
  const risk = document.getElementById("clientRisk");
  risk.textContent = riskLabel(user.riskLevel);
  risk.className = `risk ${user.riskLevel}`;
  document.getElementById("clientSummary").innerHTML = summaryChips(profile, user);
  document.getElementById("clientTags").value = (user.tags || []).join("\n");
  document.getElementById("clientFacts").value = profile.facts.join("\n");
  document.getElementById("clientMedications").value = profile.medications.join("\n");
  document.getElementById("clientDoctors").value = profile.doctors.join("\n");
  document.getElementById("clientProblems").value = profile.problems.join("\n");
  document.getElementById("clientPreferences").value = profile.preferences.join("\n");
  document.getElementById("clientNotes").value = (user.manualProfile?.psychologistNotes || []).join("\n");
  document.getElementById("clientDuration").value = profile.modalDurationMinutes || "";
  document.getElementById("clientNextAction").value = user.nextAction || "";
  document.getElementById("clientRiskSelect").value = user.riskLevel || "none";
  renderClientReminders(user.chatId);
  await renderMessages(user.chatId);
}

function summaryChips(profile, user) {
  const chips = [
    ["Факты", first(profile.facts)],
    ["Лекарства", first(profile.medications)],
    ["Врачи", first(profile.doctors)],
    ["Проблемы", first(profile.problems)],
    ["Напоминания", first(profile.reminders)],
    ["Следующее", user.nextAction || "нет"]
  ];
  return chips.map(([label, value]) => `<div class="summary-chip"><b>${label}</b><span>${escapeHtml(value || "нет")}</span></div>`).join("");
}

async function renderMessages(chatId) {
  try {
    const messages = await api(`/api/users/${encodeURIComponent(chatId)}/messages`);
    document.getElementById("messageHistory").innerHTML = messages.length
      ? messages.map((message) => `
        <article class="message ${message.role}">
          <p>${escapeHtml(message.text)}</p>
          <small>${humanDateTime(message.createdAt)} · ${message.source || message.role}</small>
        </article>
      `).join("")
      : `<div class="empty-state">История сообщений пока пустая.</div>`;
  } catch (error) {
    document.getElementById("messageHistory").innerHTML = `<div class="empty-state">Не удалось загрузить сообщения.</div>`;
  }
}

async function sendReply(event) {
  event.preventDefault();
  const text = document.getElementById("replyText").value.trim();
  if (!selectedClientId || !text) return;
  await api(`/api/users/${encodeURIComponent(selectedClientId)}/reply`, { method: "POST", body: JSON.stringify({ text }) });
  document.getElementById("replyText").value = "";
  await renderMessages(selectedClientId);
}

async function saveClientProfile() {
  const user = users.find((item) => item.chatId === selectedClientId);
  if (!user) return;
  const duration = Number(document.getElementById("clientDuration").value);
  const body = {
    tags: splitLines(document.getElementById("clientTags").value),
    riskLevel: document.getElementById("clientRiskSelect").value,
    nextAction: document.getElementById("clientNextAction").value.trim(),
    manualProfile: {
      facts: splitLines(document.getElementById("clientFacts").value),
      medications: splitLines(document.getElementById("clientMedications").value),
      doctors: splitLines(document.getElementById("clientDoctors").value),
      problems: splitLines(document.getElementById("clientProblems").value),
      preferences: splitLines(document.getElementById("clientPreferences").value),
      psychologistNotes: splitLines(document.getElementById("clientNotes").value),
      modalDurationMinutes: Number.isFinite(duration) && duration > 0 ? duration : undefined
    }
  };
  const updated = await api(`/api/users/${encodeURIComponent(user.chatId)}`, { method: "PUT", body: JSON.stringify(body) });
  users = users.map((item) => (item.chatId === updated.chatId ? updated : item));
  document.getElementById("clientSaveStatus").textContent = "Профиль сохранен.";
  renderUsers();
  renderClient();
}

function renderClientReminders(chatId) {
  const list = reminders.filter((reminder) => reminder.chatId === chatId).slice(0, 8);
  document.getElementById("clientRemindersList").innerHTML = list.length
    ? list.map((reminder) => `
      <div class="reminder-item">
        <span><b>${humanDateTime(reminder.dueAt)}</b><small>${escapeHtml(reminder.text)}</small></span>
        <span class="button-row">
          <button data-reminder-send="${escapeAttr(reminder.id)}">Сейчас</button>
          <button data-reminder-cancel="${escapeAttr(reminder.id)}">Отмена</button>
        </span>
      </div>
    `).join("")
    : `<div class="empty-state">Активных напоминаний нет.</div>`;
  document.querySelectorAll("[data-reminder-send]").forEach((button) => button.onclick = () => sendReminderNow(button.dataset.reminderSend));
  document.querySelectorAll("[data-reminder-cancel]").forEach((button) => button.onclick = () => cancelReminder(button.dataset.reminderCancel));
}

async function addManualReminder() {
  const user = users.find((item) => item.chatId === selectedClientId);
  if (!user) return;
  const text = prompt("Текст напоминания клиенту");
  if (!text) return;
  const dueAtRaw = prompt("Когда отправить? Формат: 2026-05-22 10:00");
  if (!dueAtRaw) return;
  const dueAt = new Date(dueAtRaw.replace(" ", "T") + ":00+03:00").toISOString();
  await api("/api/reminders", { method: "POST", body: JSON.stringify({ chatId: user.chatId, text, dueAt }) });
  reminders = await api("/api/reminders");
  renderClientReminders(user.chatId);
  renderOverview();
}

async function sendReminderNow(id) {
  await api(`/api/reminders/${encodeURIComponent(id)}/send-now`, { method: "POST", body: "{}" });
  reminders = await api("/api/reminders");
  renderClient();
}

async function cancelReminder(id) {
  await api(`/api/reminders/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
  reminders = await api("/api/reminders");
  renderClient();
  renderOverview();
}

async function renderCalendarStatus() {
  const status = await api("/api/calendar/status");
  const node = document.getElementById("calendarStatus");
  if (!status.configured) {
    node.innerHTML = `<b>Google еще не настроен</b><p>Добавьте OAuth secrets в Cloudflare: ${escapeHtml(status.missing.join(", "))}</p>`;
    return;
  }
  if (!status.connected) {
    node.innerHTML = `<b>Google готов к подключению</b><p>Нажмите «Подключить Google», выберите аккаунт психолога и разрешите календарь.</p>`;
    return;
  }
  node.innerHTML = `<b>Google подключен</b><p>Аккаунт: ${escapeHtml(status.email || "не указан")}. Занятость синхронизируется вручную и при записи.</p>`;
}

async function syncCalendar() {
  const result = await api("/api/calendar/sync", { method: "POST", body: "{}" });
  bookings = await api("/api/calendar/bookings");
  await loadAvailability(Number(document.getElementById("availabilityDuration").value || 30));
  renderCalendarBoard();
  renderOverview();
  document.getElementById("saveStatus").textContent = result.ok ? `Google синхронизирован. Занятых событий: ${result.busyWritten || 0}.` : `Google: ${result.reason}`;
}

function availabilityListItem(slot) {
  return `<button class="slot-list-item" data-availability-id="${escapeAttr(slot.id)}"><span><b>${humanDate(slot.startsAt)}</b><small>${timeRange(slot)} · ${slot.durationMinutes} мин</small></span><em class="status-pill free">свободно</em></button>`;
}

function formatWindows(windows) {
  return (windows || []).map((item) => `${item.start}-${item.end}`).join(", ");
}

function parseWindows(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("-").map((item) => item.trim());
      return start && end ? { start, end } : null;
    })
    .filter(Boolean);
}

function mergedProfile(user) {
  const agent = user.agentProfile || {};
  const manual = user.manualProfile || {};
  return {
    facts: unique([...(agent.facts || []), ...(manual.facts || [])]),
    medications: unique([...(agent.medications || []), ...(manual.medications || [])]),
    doctors: unique([...(agent.doctors || []), ...(manual.doctors || [])]),
    appointments: unique([...(agent.appointments || []), ...(manual.appointments || [])]),
    problems: unique([...(agent.problems || []), ...(manual.problems || [])]),
    preferences: unique([...(agent.preferences || []), ...(manual.preferences || [])]),
    riskNotes: unique([...(agent.riskNotes || []), ...(manual.riskNotes || [])]),
    reminders: unique([...(agent.reminders || []), ...(manual.reminders || [])]),
    psychologistNotes: unique([...(agent.psychologistNotes || []), ...(manual.psychologistNotes || [])]),
    sessionHistory: [...(agent.sessionHistory || []), ...(manual.sessionHistory || [])],
    modalDurationMinutes: manual.modalDurationMinutes || agent.modalDurationMinutes
  };
}

function splitLines(value) {
  return unique(value.split("\n").map((line) => line.trim()).filter(Boolean));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function first(values) {
  return (values || [])[0] || "";
}

function riskLabel(value) {
  return value === "urgent" ? "срочно" : value === "watch" ? "наблюдать" : "нет риска";
}

function displayClientName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || `Клиент ${user.chatId}`;
}

function nextDays(count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.now() + index * 24 * 60 * 60 * 1000);
    return {
      key: dateKey(date.toISOString()),
      weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "Europe/Moscow" }).format(date),
      label: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(date)
    };
  });
}

function dateKey(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function timeRange(item) {
  const format = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return `${format.format(new Date(item.startsAt))}-${format.format(new Date(item.endsAt))}`;
}

function humanDate(value) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function humanDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
