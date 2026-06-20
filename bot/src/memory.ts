import type { DurableObjectState } from "@cloudflare/workers-types";

export type MemoryTurn = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type UserProfile = {
  chatId: string;
  name?: string;
  preferredContact?: string;
  statedNeeds: string[];
  bookingHistory: string[];
  updatedAt: string;
};

export class ChatMemory {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/context") {
      return Response.json(await this.readContext());
    }
    if (request.method === "POST" && url.pathname === "/turn") {
      const turn = (await request.json()) as MemoryTurn;
      await this.addTurn(turn);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/profile") {
      const patch = (await request.json()) as Partial<UserProfile>;
      const profile = await this.patchProfile(patch);
      return Response.json(profile);
    }
    if (request.method === "GET" && url.pathname === "/kv") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing_key", { status: 400 });
      const value = await this.state.storage.get(key);
      return Response.json({ found: value !== undefined, value });
    }
    if (request.method === "PUT" && url.pathname === "/kv") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing_key", { status: 400 });
      const value = await request.json();
      await this.state.storage.put(key, value);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/append-jsonl") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing_key", { status: 400 });
      const record = await request.json();
      const current = ((await this.state.storage.get(key)) as string | undefined) ?? "";
      await this.state.storage.put(key, `${current}${JSON.stringify(record)}\n`);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/lock/acquire") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing_key", { status: 400 });
      const body = (await request.json()) as { lockId?: string; ttlMs?: number };
      const lockId = body.lockId ?? crypto.randomUUID();
      const ttlMs = Math.min(Math.max(body.ttlMs ?? 10_000, 1000), 30_000);
      const now = Date.now();
      const current = (await this.state.storage.get(`lock:${key}`)) as { lockId: string; expiresAt: number } | undefined;
      if (current && current.expiresAt > now) return Response.json({ ok: false, lockId: current.lockId });
      await this.state.storage.put(`lock:${key}`, { lockId, expiresAt: now + ttlMs });
      return Response.json({ ok: true, lockId });
    }
    if (request.method === "POST" && url.pathname === "/lock/release") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing_key", { status: 400 });
      const body = (await request.json()) as { lockId?: string };
      const current = (await this.state.storage.get(`lock:${key}`)) as { lockId: string; expiresAt: number } | undefined;
      if (!current || current.lockId === body.lockId) await this.state.storage.delete(`lock:${key}`);
      return Response.json({ ok: true });
    }
    return new Response("not_found", { status: 404 });
  }

  private async readContext(): Promise<{ turns: MemoryTurn[]; profile: UserProfile | null }> {
    const turns = ((await this.state.storage.get("turns")) as MemoryTurn[] | undefined) ?? [];
    const profile = ((await this.state.storage.get("profile")) as UserProfile | undefined) ?? null;
    return { turns, profile };
  }

  private async addTurn(turn: MemoryTurn): Promise<void> {
    const turns = ((await this.state.storage.get("turns")) as MemoryTurn[] | undefined) ?? [];
    turns.push(turn);
    await this.state.storage.put("turns", turns.slice(-40));
  }

  private async patchProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
    const current = ((await this.state.storage.get("profile")) as UserProfile | undefined) ?? {
      chatId: patch.chatId ?? "unknown",
      statedNeeds: [],
      bookingHistory: [],
      updatedAt: new Date().toISOString()
    };
    const next: UserProfile = {
      ...current,
      ...patch,
      statedNeeds: patch.statedNeeds ?? current.statedNeeds,
      bookingHistory: patch.bookingHistory ?? current.bookingHistory,
      updatedAt: new Date().toISOString()
    };
    await this.state.storage.put("profile", next);
    return next;
  }
}

export function memoryStub(env: { CHAT_MEMORY: DurableObjectNamespace }, chatId: string): DurableObjectStub {
  const objectId = env.CHAT_MEMORY.idFromName(chatId);
  return env.CHAT_MEMORY.get(objectId);
}

export function appStateStub(env: { CHAT_MEMORY: DurableObjectNamespace }): DurableObjectStub {
  const objectId = env.CHAT_MEMORY.idFromName("__app_state__");
  return env.CHAT_MEMORY.get(objectId);
}
