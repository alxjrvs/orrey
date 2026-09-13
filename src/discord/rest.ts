import type { Env } from "../env.ts";


const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  // Plain fields, not parameter properties: the scripts run under Node's
  // type stripping, which refuses `constructor(readonly x: T)`.
  readonly status: number;
  readonly code: number | undefined;
  /** Set on a 429. How long the whole guild should wait, not just this call. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: number | undefined, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  /** 50007 — cannot DM this user. Permanent; fall back to a channel mention. */
  get isClosedDm(): boolean {
    return this.code === 50007;
  }

}

/**
 * What a DiscordError looks like once it has crossed a Durable Object RPC
 * boundary: its fields survive, its prototype does not. So work that ran inside
 * the GuildGovernor throws something that is *not* `instanceof DiscordError`,
 * and every catch outside that boundary has to read structure instead.
 */
export interface DiscordFailure {
  status: number;
  code: number | undefined;
  retryAfterMs: number | undefined;
}

export function asDiscordFailure(error: unknown): DiscordFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown; retryAfterMs?: unknown };
  if (candidate.name !== "DiscordError" || typeof candidate.status !== "number") return undefined;
  return {
    status: candidate.status,
    code: typeof candidate.code === "number" ? candidate.code : undefined,
    retryAfterMs: typeof candidate.retryAfterMs === "number" ? candidate.retryAfterMs : undefined,
  };
}

/** 10070 / 404 — the scheduled event is gone. Mint a new one; do not retry. */
export function isUnknownEvent(error: unknown): boolean {
  const failure = asDiscordFailure(error);
  return failure !== undefined && (failure.code === 10070 || failure.status === 404);
}

interface DiscordRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Only the bot token is needed, so scripts can call this without a full Env. */
export type BotAuth = Pick<Env, "DISCORD_BOT_TOKEN">;

export async function discordFetch<T>(
  env: BotAuth,
  path: string,
  init: DiscordRequest = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      code?: number;
      message?: string;
      retry_after?: number;
    };
    throw new DiscordError(
      response.status,
      payload.code,
      `${init.method ?? "GET"} ${path} -> ${response.status} ${payload.message ?? ""}`.trim(),
      response.status === 429 ? retryAfterMs(response, payload.retry_after) : undefined,
    );
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** Discord answers a 429 in seconds, in the body or the header. */
function retryAfterMs(response: Response, fromBody: number | undefined): number {
  const seconds = fromBody ?? Number(response.headers.get("retry-after") ?? 1);
  return Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
}

/**
 * Scheduled events are the only Discord objects Orrey reconciles, so these are
 * the only Discord writes that ever happen twice for the same thing.
 */
export interface ScheduledEvent {
  id: string;
  name: string;
  status: number;
}

export function createScheduledEvent(env: BotAuth, guildId: string, body: unknown) {
  return discordFetch<ScheduledEvent>(env, `/guilds/${guildId}/scheduled-events`, {
    method: "POST",
    body,
  });
}

export function modifyScheduledEvent(
  env: BotAuth,
  guildId: string,
  eventId: string,
  body: unknown,
) {
  return discordFetch<ScheduledEvent>(env, `/guilds/${guildId}/scheduled-events/${eventId}`, {
    method: "PATCH",
    body,
  });
}

export function deleteScheduledEvent(env: BotAuth, guildId: string, eventId: string) {
  return discordFetch<void>(env, `/guilds/${guildId}/scheduled-events/${eventId}`, {
    method: "DELETE",
  });
}

/** Fire-and-forget. Record the id if you want it; never reconcile it. */
export function postMessage(env: BotAuth, channelId: string, body: unknown) {
  return discordFetch<{ id: string; channel_id: string }>(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body,
  });
}

/**
 * Strips components from a message. Used exactly once, at cutover, to neutralise
 * Hermuz's old interactive posts. Not a general-purpose edit.
 */
export function stripComponents(env: BotAuth, channelId: string, messageId: string) {
  return discordFetch(env, `/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: { components: [] },
  });
}
