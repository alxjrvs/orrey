import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rememberUser } from "../db/users.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * Console login. Discord is the only identity Orrey has, and this is the only
 * place that fact is at risk of quietly stopping being true.
 *
 * **`identify` and nothing else.** Not `guilds`, not `guilds.members.read`. The
 * cheapest way to guarantee that roles never come from the user's own token is
 * never to have asked for them: membership and roles are read with the *bot*
 * token, from the guild member endpoint, which is a different PR and a different
 * file.
 *
 * **No PKCE.** Orrey is a confidential client — it has a client secret — so a
 * verifier adds nothing, and whether Discord's token endpoint accepts one is
 * undocumented. Relying on an undocumented acceptance is how a login breaks
 * silently on somebody else's deploy.
 */
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/v10/oauth2/token";
const DISCORD_ME = "https://discord.com/api/v10/users/@me";

export const SCOPE = "identify";

/** Where Discord sends the browser back. One value, derived, never configured twice. */
export function redirectUri(origin: string): string {
  return `${origin}/console/callback`;
}

export function authorizeUrl(env: Env, origin: string, state: string): string {
  const url = new URL(DISCORD_AUTHORIZE);
  url.searchParams.set("client_id", env.DISCORD_APPLICATION_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(origin));
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  // `none` skips Discord's consent screen for somebody who has already granted
  // `identify` — which is every login after the first. The friction that matters
  // is upstream: the link is short-lived and comes from a command only that
  // person can run, so making them re-approve the same scope weekly would buy
  // nothing and train them to click through it.
  url.searchParams.set("prompt", "none");
  return url.toString();
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

export class OAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
}

export async function exchangeCode(env: Env, origin: string, code: string): Promise<TokenPair> {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin),
  });
}

/**
 * Discord rotates refresh tokens: the response carries a *new* one, and the old
 * one stops working. Storing only the access token, or keeping the old refresh
 * token, is how somebody ends up permanently logged out a week later.
 */
export function refresh(env: Env, refreshToken: string): Promise<TokenPair> {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

async function tokenRequest(env: Env, fields: Record<string, string>): Promise<TokenPair> {
  const response = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_APPLICATION_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      ...fields,
    }),
  });

  if (!response.ok) {
    throw new OAuthError(response.status, `token endpoint said ${response.status}`);
  }

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!body.access_token || !body.refresh_token) {
    throw new OAuthError(502, "token response carried no token pair");
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 0),
  };
}

/** Who the token belongs to. The only thing `identify` is for. */
export async function identify(accessToken: string): Promise<InteractionUser> {
  const response = await fetch(DISCORD_ME, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new OAuthError(response.status, `/users/@me said ${response.status}`);

  const body = (await response.json()) as {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
  if (!body.id || !body.username) throw new OAuthError(502, "/users/@me carried no user");

  return { id: body.id, username: body.username, global_name: body.global_name ?? null };
}

/**
 * The pair, stored per person and replaced whole on every refresh. `users` is
 * upserted first because `discord_tokens` references it — and because the names
 * are a cache that every sighting of somebody should refresh.
 */
export async function storeTokens(env: Env, user: InteractionUser, pair: TokenPair): Promise<void> {
  await rememberUser(env, user);

  const row = {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt,
    updatedAt: sql`(unixepoch())`,
  };

  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: user.id, ...row })
    .onConflictDoUpdate({ target: schema.discordTokens.userId, set: row });
}

export function storedTokens(env: Env, userId: string) {
  return db(env)
    .select()
    .from(schema.discordTokens)
    .where(eq(schema.discordTokens.userId, userId))
    .get();
}

/** A refresh that fails is a logged-out person, not an error to retry into. */
export async function forgetTokens(env: Env, userId: string): Promise<void> {
  await db(env).delete(schema.discordTokens).where(eq(schema.discordTokens.userId, userId));
}
