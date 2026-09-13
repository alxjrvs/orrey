import type { Env } from "../env.ts";


const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  // Plain fields, not parameter properties: the scripts run under Node's
  // type stripping, which refuses `constructor(readonly x: T)`.
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, code: number | undefined, message: string) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
    this.code = code;
  }

  /** 50007 — cannot DM this user. Permanent; fall back to a channel mention. */
  get isClosedDm(): boolean {
    return this.code === 50007;
  }
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
    const payload = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
    throw new DiscordError(
      response.status,
      payload.code,
      `${init.method ?? "GET"} ${path} -> ${response.status} ${payload.message ?? ""}`.trim(),
    );
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
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
