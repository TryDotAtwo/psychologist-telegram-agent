import type { BotConfig, ClientProfileData, ClientReminder, ClientRiskLevel, Env } from "./types";

type ContextPayload = {
  profile: unknown;
  turns: { role: string; text: string; createdAt: string }[];
};

const ANSWER_TIMEOUT_MS = 12_000;
const EXTRACTION_TIMEOUT_MS = 6_000;

export type ClientExtraction = {
  tags?: string[];
  profile?: Partial<ClientProfileData>;
  riskLevel?: ClientRiskLevel;
  nextAction?: string;
  reminders?: Omit<ClientReminder, "id" | "chatId" | "status" | "source" | "createdAt" | "updatedAt">[];
};

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

export async function extractClientProfilePatch(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<ClientExtraction | null> {
  if (!env.OPENROUTER_API_KEY) return heuristicExtraction(userText, env.TIMEZONE || "Europe/Moscow");
  const payload = {
    model: env.OPENROUTER_MODEL ?? "openrouter/owl-alpha",
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
    temperature: 0.1
  };

  try {
    const content = await completeOpenRouter(env, payload, EXTRACTION_TIMEOUT_MS);
    return sanitizeExtraction(JSON.parse(stripJsonFences(content)) as ClientExtraction, env.TIMEZONE || "Europe/Moscow");
  } catch {
    return heuristicExtraction(userText, env.TIMEZONE || "Europe/Moscow");
  }
}

async function answerWithOpenRouter(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<string> {
  const tools = config.searchEnabled && shouldUseWebSearch(userText) ? [{ type: "openrouter:web_search", parameters: { max_results: 3 } }] : undefined;
  const payload = {
    model: env.OPENROUTER_MODEL ?? "openrouter/owl-alpha",
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
    temperature: 0.4
  };

  try {
    return await completeOpenRouter(env, payload, ANSWER_TIMEOUT_MS);
  } catch (error) {
    if (!tools) throw error;
    return completeOpenRouter(env, { ...payload, tools: undefined }, ANSWER_TIMEOUT_MS);
  }
}

async function completeOpenRouter(env: Env, payload: unknown, timeoutMs: number): Promise<string> {
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
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`openrouter_status=${response.status}; body=${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("openrouter_empty_message_content");
  return text;
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

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 20);
}

function stripJsonFences(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
