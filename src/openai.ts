import type { BotConfig, ClientProfileData, ClientReminder, ClientRiskLevel, Env } from "./types";

type ContextPayload = {
  profile: unknown;
  turns: { role: string; text: string; createdAt: string }[];
};

type OpenRouterPayload = {
  model?: string;
  models?: string[];
  route?: "fallback";
  messages: { role: "system" | "user"; content: string }[];
  tools?: unknown;
  temperature: number;
  max_tokens?: number;
};

type OpenRouterMessageContent = string | { type?: string; text?: string }[] | null | undefined;
type OpenRouterResponse = {
  choices?: {
    text?: string;
    message?: {
      content?: OpenRouterMessageContent;
    };
  }[];
};

const ANSWER_TIMEOUT_MS = 28_000;
const EXTRACTION_TIMEOUT_MS = 10_000;
const ANSWER_MODEL_TIMEOUT_MS = 10_000;
const EXTRACTION_MODEL_TIMEOUT_MS = 5_000;
const ACTION_EXTRACTION_TIMEOUT_MS = 6_000;
const ACTION_EXTRACTION_MODEL_TIMEOUT_MS = 3_500;
const OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4-flash:free";
const OPENROUTER_FINAL_ROUTER = "openrouter/free";
const OPENROUTER_FREE_FALLBACK_MODELS = [
  "deepseek/deepseek-v4-flash:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-120b:free",
  "z-ai/glm-4.5-air:free",
  "qwen/qwen3-coder:free"
];

export type ClientExtraction = {
  tags?: string[];
  profile?: Partial<ClientProfileData>;
  riskLevel?: ClientRiskLevel;
  nextAction?: string;
  reminders?: Omit<ClientReminder, "id" | "chatId" | "status" | "source" | "createdAt" | "updatedAt">[];
};

export type AgentActionPlan = {
  kind: "none" | "reminder_create" | "booking_create" | "profile_update";
  confidence: number;
  summary?: string;
  missingFields?: string[];
  fields?: Record<string, unknown>;
};

export async function extractAgentActionPlan(
  env: Env,
  config: BotConfig,
  userText: string,
  context: ContextPayload,
  pendingAction?: unknown
): Promise<AgentActionPlan | null> {
  const timezone = env.TIMEZONE || "Europe/Moscow";
  const system = [
    "Ты агент-диспетчер Telegram-бота психолога.",
    "Твоя задача: определить, просит ли клиент выполнить действие: создать напоминание, записаться на консультацию, запомнить факт, добавить данные в профиль.",
    "Если клиент просто разговаривает или задает вопрос, верни kind=\"none\".",
    "Если клиент сообщает переживание, симптом, факт о себе или вопрос без слов сохранить/запомнить/добавить в профиль, верни kind=\"none\": долговременная память обновится отдельным пакетным профилированием.",
    "Если клиент спрашивает свободные окна, цены или расписание без явной просьбы забронировать конкретное время, верни kind=\"none\".",
    "Создавай reminder_create только при явной просьбе напомнить.",
    "Создавай booking_create только при явной просьбе записать/забронировать/поставить встречу.",
    "Создавай profile_update только при явной просьбе запомнить/сохранить/добавить информацию в профиль.",
    "Если действие найдено, верни только JSON без markdown.",
    "Не исполняй действие сам. Только предложи структурированные поля для последующего подтверждения программой.",
    "Для напоминаний о лекарствах записывай только текст клиента, не добавляй дозировки и медицинские инструкции от себя.",
    "Для reminder_create исправляй очевидные орфографические ошибки в тексте напоминания без изменения смысла.",
    "Если reminder_create относится к приему препарата, заполни fields.reminderKind=\"medication\" и fields.medicationName названием препарата; если не относится, fields.reminderKind=\"general\".",
    "Для записи используй ISO-дату со смещением +03:00, если дата и время понятны. Если не хватает даты, времени или длительности, перечисли недостающие поля.",
    "Если клиент просит запись и указывает время без дня, используй сегодняшний день в timezone.",
    "Если клиент просит запись без длительности, верни durationMinutes=null: программа подставит бесплатное знакомство для нового клиента или модальную длительность прошлых встреч для возвращающегося клиента.",
    "Если клиент просит напоминание каждый день с конкретного часа, верни reminder_create с repeat=\"daily\", текстом из слов клиента и ближайшим dueAt в timezone.",
    "Если есть existing_pending_action, трактуй сообщение клиента как правку к pending action и верни обновленное действие того же типа, если возможно.",
    `current_time=${new Date().toISOString()}`,
    `timezone=${timezone}`,
    `services=${JSON.stringify(config.services)}`,
    `prices=${JSON.stringify(config.prices)}`,
    `memory_context=${JSON.stringify(context).slice(0, 20_000)}`,
    `existing_pending_action=${JSON.stringify(pendingAction ?? null)}`,
    "JSON schema: {\"kind\":\"none|reminder_create|booking_create|profile_update\",\"confidence\":0..1,\"summary\":string,\"missingFields\":string[],\"fields\":{}}",
    "reminder_create.fields={\"text\":string,\"dueAt\":ISO8601|null,\"timezone\":string,\"repeat\":\"none|daily|weekly|monthly\",\"reminderKind\":\"general|medication\",\"medicationName\":string|null}",
    "booking_create.fields={\"startsAt\":ISO8601|null,\"date\":\"YYYY-MM-DD|null\",\"time\":\"HH:mm|null\",\"durationMinutes\":number|null,\"serviceId\":string|null,\"note\":string|null}",
    "profile_update.fields={\"tags\":string[],\"profile\":{\"facts\":string[],\"medications\":string[],\"doctors\":string[],\"appointments\":string[],\"problems\":string[],\"preferences\":string[],\"riskNotes\":string[],\"reminders\":string[]},\"riskLevel\":\"none|watch|urgent\",\"nextAction\":string|null}"
  ].join("\n");
  const user = `Сообщение клиента: ${userText}`;
  try {
    const content = env.OPENROUTER_API_KEY
      ? await completeOpenRouterWithModelFallbacks(
          env,
          {
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ],
            temperature: 0.1,
            max_tokens: 700
          },
          ACTION_EXTRACTION_TIMEOUT_MS,
          ACTION_EXTRACTION_MODEL_TIMEOUT_MS
        )
      : await completeOpenAiJson(env, system, user, ACTION_EXTRACTION_TIMEOUT_MS);
    return sanitizeAgentActionPlan(JSON.parse(stripJsonFences(content)) as AgentActionPlan);
  } catch {
    return null;
  }
}

export async function answerWithOpenAI(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<string> {
  if (!env.OPENAI_API_KEY && env.OPENROUTER_API_KEY) return answerWithOpenRouter(env, config, userText, context);
  if (!env.OPENAI_API_KEY) throw new Error("missing_ai_provider_secret");

  const tools = config.searchEnabled && shouldUseWebSearch(userText) ? [{ type: "web_search_preview" }] : [];
  const payload = {
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          config.systemPrompt,
          config.crisisPrompt,
          `services=${JSON.stringify(config.services)}`,
          `prices=${JSON.stringify(config.prices)}`,
          `memory_context=${JSON.stringify(context)}`
        ].join("\n\n")
      },
      { role: "user", content: userText }
    ],
    tools,
    temperature: 0.4
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`openai_status=${response.status}; body=${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { output_text?: string };
  if (!data.output_text) throw new Error("openai_empty_output_text");
  return data.output_text;
}

async function completeOpenAiJson(env: Env, system: string, user: string, timeoutMs: number): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new Error("missing_ai_provider_secret");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.1
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`openai_status=${response.status}; body=${(await response.text()).slice(0, 500)}`);
  const data = (await response.json()) as { output_text?: string };
  if (!data.output_text) throw new Error("openai_empty_output_text");
  return data.output_text;
}

export async function extractClientProfilePatch(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<ClientExtraction | null> {
  if (!env.OPENROUTER_API_KEY) return heuristicExtraction(userText, env.TIMEZONE || "Europe/Moscow");
  const payload: OpenRouterPayload = {
    messages: [
      {
        role: "system",
        content: [
          "Ты извлекаешь структурированные факты из одного сообщения клиента психолога.",
          "Верни только JSON без markdown.",
          "Не ставь диагнозы. Медицинские данные записывай как слова клиента.",
          "Не создавай напоминание о препаратах, если клиент явно не попросил напомнить.",
          "manualProfile психолога нельзя менять: возвращай только agent profile patch.",
          `known_services=${JSON.stringify(config.services)}`,
          `context=${JSON.stringify(context)}`
        ].join("\n")
      },
      {
        role: "user",
        content:
          `Сообщение клиента: ${userText}\n\n` +
          "JSON schema: {\"tags\":string[],\"profile\":{\"facts\":string[],\"medications\":string[],\"doctors\":string[],\"appointments\":string[],\"problems\":string[],\"preferences\":string[],\"riskNotes\":string[],\"reminders\":string[],\"sessionHistory\":[],\"modalDurationMinutes\":number|null},\"riskLevel\":\"none|watch|urgent\",\"nextAction\":string|null,\"reminders\":[{\"text\":string,\"dueAt\":ISO8601,\"timezone\":string}]}"
      }
    ],
    temperature: 0.1,
    max_tokens: 600
  };

  try {
    const content = await completeOpenRouterWithModelFallbacks(env, payload, EXTRACTION_TIMEOUT_MS, EXTRACTION_MODEL_TIMEOUT_MS);
    return sanitizeExtraction(JSON.parse(stripJsonFences(content)) as ClientExtraction, env.TIMEZONE || "Europe/Moscow");
  } catch {
    return heuristicExtraction(userText, env.TIMEZONE || "Europe/Moscow");
  }
}

async function answerWithOpenRouter(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<string> {
  const tools = config.searchEnabled && shouldUseWebSearch(userText) ? [{ type: "openrouter:web_search", parameters: { max_results: 3 } }] : undefined;
  const payload: OpenRouterPayload = {
    messages: [
      {
        role: "system",
        content: [
          config.systemPrompt,
          config.crisisPrompt,
          `services=${JSON.stringify(config.services)}`,
          `prices=${JSON.stringify(config.prices)}`,
          `memory_context=${JSON.stringify(context)}`,
          "Если вопрос про запись, цены или расписание, отвечай кратко и предложи использовать команды: свободные окна, цены."
        ].join("\n\n")
      },
      { role: "user", content: userText }
    ],
    tools,
    temperature: 0.4,
    max_tokens: 520
  };

  try {
    return await completeOpenRouterWithModelFallbacks(env, payload, ANSWER_TIMEOUT_MS, ANSWER_MODEL_TIMEOUT_MS);
  } catch (error) {
    if (!tools) throw error;
    return completeOpenRouterWithModelFallbacks(env, { ...payload, tools: undefined }, ANSWER_TIMEOUT_MS, ANSWER_MODEL_TIMEOUT_MS);
  }
}

export function openRouterModelCandidates(env: Pick<Env, "OPENROUTER_MODEL">, rotateFallbacks = false): string[] {
  const configured = env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL;
  const primary = configured === OPENROUTER_FINAL_ROUTER ? OPENROUTER_DEFAULT_MODEL : configured;
  const fallbackModels = rotateFallbacks ? rotateModels(OPENROUTER_FREE_FALLBACK_MODELS) : OPENROUTER_FREE_FALLBACK_MODELS;
  return [...new Set([primary, ...fallbackModels, OPENROUTER_FINAL_ROUTER])];
}

function rotateModels(models: string[]): string[] {
  if (models.length < 2) return models;
  const shift = randomIndex(models.length);
  return [...models.slice(shift), ...models.slice(0, shift)];
}

function randomIndex(maxExclusive: number): number {
  try {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] % maxExclusive;
  } catch {
    return Date.now() % maxExclusive;
  }
}

async function completeOpenRouterWithModelFallbacks(env: Env, payload: OpenRouterPayload, totalTimeoutMs: number, modelTimeoutMs: number): Promise<string> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(modelTimeoutMs, totalTimeoutMs);
  const controllers: AbortController[] = [];
  const attempts = chunk(openRouterModelCandidates(env, true), 3).map((models) => {
    const controller = new AbortController();
    const routePayload = models.length > 1 ? { ...payload, model: undefined, models, route: "fallback" as const } : { ...payload, model: models[0], models: undefined };
    controllers.push(controller);
    return completeOpenRouter(env, routePayload, timeoutMs, controller.signal)
      .then((text) => {
        controllers.forEach((item) => {
          if (item !== controller) item.abort();
        });
        return text;
      })
      .catch((error) => {
        throw new Error(`${models.join(" -> ")}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 320));
      });
  });
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))) : [String(error)];
    const elapsedMs = Date.now() - startedAt;
    throw new Error(`openrouter_all_models_failed; elapsedMs=${elapsedMs}; attempts=${errors.join(" | ").slice(0, 1400)}`);
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function completeOpenRouter(env: Env, payload: OpenRouterPayload, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const baseUrl = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://xn--80a3aie.xn--p1ai/bot/",
      "X-Title": "Psychologist Telegram Agent"
    },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`openrouter_status=${response.status}; body=${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as OpenRouterResponse;
  const text = extractOpenRouterText(data);
  if (!text) throw new Error("openrouter_empty_message_content");
  return text;
}

function extractOpenRouterText(data: OpenRouterResponse): string {
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (item.type === "text" || !item.type ? item.text ?? "" : ""))
      .join("")
      .trim();
  }
  return choice?.text?.trim() ?? "";
}

function shouldUseWebSearch(text: string): boolean {
  return /(погугл|найди|поиск|источник|ссылка|новост|сейчас|актуальн|сегодня|курс|закон|исследован|статья|кто такой|что известно)/i.test(text);
}

function heuristicExtraction(text: string, timezone: string): ClientExtraction {
  const normalized = text.toLowerCase();
  const profile: Partial<ClientProfileData> = {
    facts: [],
    medications: [],
    doctors: [],
    appointments: [],
    problems: [],
    preferences: [],
    riskNotes: [],
    reminders: []
  };
  const tags: string[] = [];
  let riskLevel: ClientRiskLevel = "none";
  let nextAction: string | undefined;

  if (/запис|слот|окн|консультац|встреч/.test(normalized)) {
    tags.push("запись");
    nextAction = "Проверить запись и подтвердить удобное время.";
  }
  if (/таблет|лекарств|медикамент|антидепресс|стимулятор/.test(normalized)) {
    tags.push("медицина");
    profile.medications?.push(`Клиент упомянул лекарства: ${text.slice(0, 180)}`);
  }
  if (/психиатр|невролог|врач|терапевт/.test(normalized)) profile.doctors?.push(`Клиент упомянул врача: ${text.slice(0, 180)}`);
  if (/тревог|паник|выгор|депресс|сон|сенсор|перегруз/.test(normalized)) profile.problems?.push(text.slice(0, 180));
  if (/рас|аутиз|сдвг|нейро/.test(normalized)) tags.push("нейроотличность");
  if (/самоуб|суицид|умереть|убить себя|навредить себе|не хочу жить/.test(normalized)) {
    riskLevel = "urgent";
    tags.push("кризис");
    profile.riskNotes?.push(`Срочный риск в сообщении: ${text.slice(0, 180)}`);
    nextAction = "Срочно вручную проверить диалог и дать кризисные контакты при необходимости.";
  } else if (/плохо|срыв|кризис|истерик|опасн/.test(normalized)) {
    riskLevel = "watch";
    tags.push("наблюдение");
  }
  const rememberMatch = text.match(/(?:запомни|важно|факт)[:\s]+(.{8,180})/i);
  if (rememberMatch?.[1]) profile.facts?.push(rememberMatch[1].trim());
  return sanitizeExtraction({ tags, profile, riskLevel, nextAction, reminders: [] }, timezone);
}

function sanitizeExtraction(value: ClientExtraction, timezone: string): ClientExtraction {
  const profile = value.profile ?? {};
  const reminders = (value.reminders ?? [])
    .filter((item) => item.text && item.dueAt && Date.parse(item.dueAt) > Date.now())
    .map((item) => ({ text: item.text.slice(0, 500), dueAt: new Date(item.dueAt).toISOString(), timezone: item.timezone || timezone }))
    .slice(0, 3);
  return {
    tags: normalizeList(value.tags),
    profile: {
      facts: normalizeList(profile.facts),
      medications: normalizeList(profile.medications),
      doctors: normalizeList(profile.doctors),
      appointments: normalizeList(profile.appointments),
      problems: normalizeList(profile.problems),
      preferences: normalizeList(profile.preferences),
      riskNotes: normalizeList(profile.riskNotes),
      reminders: normalizeList(profile.reminders),
      sessionHistory: profile.sessionHistory ?? [],
      modalDurationMinutes: typeof profile.modalDurationMinutes === "number" ? profile.modalDurationMinutes : undefined
    },
    riskLevel: value.riskLevel === "urgent" || value.riskLevel === "watch" ? value.riskLevel : "none",
    nextAction: value.nextAction?.trim() || undefined,
    reminders
  };
}

function sanitizeAgentActionPlan(value: AgentActionPlan): AgentActionPlan {
  const kind = value.kind;
  if (kind !== "reminder_create" && kind !== "booking_create" && kind !== "profile_update") {
    return { kind: "none", confidence: 0, missingFields: [], fields: {} };
  }
  const fields = value.fields && typeof value.fields === "object" ? value.fields : {};
  return {
    kind,
    confidence: typeof value.confidence === "number" ? Math.min(Math.max(value.confidence, 0), 1) : 0.5,
    summary: String(value.summary || "").slice(0, 500),
    missingFields: normalizeList(value.missingFields),
    fields
  };
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 20);
}

function stripJsonFences(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
