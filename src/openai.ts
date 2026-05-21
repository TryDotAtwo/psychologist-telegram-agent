import type { BotConfig, Env } from "./types";

type ContextPayload = {
  profile: unknown;
  turns: { role: string; text: string; createdAt: string }[];
};

export async function answerWithOpenAI(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<string> {
  if (!env.OPENAI_API_KEY && env.OPENROUTER_API_KEY) {
    return answerWithOpenRouter(env, config, userText, context);
  }
  if (!env.OPENAI_API_KEY) throw new Error("missing_ai_provider_secret");

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
    tools: config.searchEnabled ? [{ type: "web_search_preview" }] : [],
    temperature: 0.4
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`openai_status=${response.status}; body=${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { output_text?: string };
  if (!data.output_text) throw new Error("openai_empty_output_text");
  return data.output_text;
}

async function answerWithOpenRouter(env: Env, config: BotConfig, userText: string, context: ContextPayload): Promise<string> {
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
          "provider_note=OpenRouter fallback is active; use web search only when the user asks about current facts, external sources, or uncertain factual claims."
        ].join("\n\n")
      },
      { role: "user", content: userText }
    ],
    tools: config.searchEnabled ? [{ type: "openrouter:web_search", parameters: { max_results: 3 } }] : [],
    temperature: 0.4
  };

  const baseUrl = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://psychologist-telegram-agent.workers.dev",
      "X-Title": "Psychologist Telegram Agent"
    },
    body: JSON.stringify(payload)
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
