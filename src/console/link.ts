import type { Env } from "../env.ts";
import { sign, verify } from "./cookies.ts";

/**
 * The console has no public front door. You get in by running `/console` in
 * Discord, which answers — only to you — with a link carrying a short-lived
 * signed token, and `/console/login` refuses to start an OAuth round trip
 * without one.
 *
 * That is what stops the login endpoint being something anybody can point a
 * browser at: the redirect it issues is a real Discord authorize URL, and one
 * that arrives unasked-for is a phishing primitive rather than a convenience.
 *
 * It is signed for **`login` and nothing else**, which is not a detail. The
 * session cookie is the same shape of payload signed with the same key, so
 * without a purpose inside the signed bytes this token *is* a session cookie —
 * and it travels in a URL, where a browser keeps it in history and a link
 * preview fetches it. `sign` takes the purpose for that reason.
 *
 * It is **not single-use.** Doing that needs a table whose only content is spent
 * nonces, and within five minutes the only person who can replay this link is
 * somebody already reading the asker's ephemeral Discord messages — at which
 * point the link is not the thing that has gone wrong. Short and bound to one
 * person buys the same thing for none of the machinery.
 */
const LINK_SECONDS = 5 * 60;

export async function loginLink(env: Env, origin: string, userId: string, now: Date): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1000) + LINK_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  return `${origin}/console/login?t=${payload}.${await sign(env, "login", payload)}`;
}

/** The id the link was minted for, or undefined for anything else. */
export async function readLoginToken(
  env: Env,
  token: string | undefined,
  now: Date,
): Promise<string | undefined> {
  if (!token) return undefined;

  const cut = token.lastIndexOf(".");
  if (cut < 0) return undefined;

  const payload = token.slice(0, cut);
  if (!(await verify(env, "login", payload, token.slice(cut + 1)))) return undefined;

  const [userId, expiresAt] = payload.split(".");
  if (!userId || !expiresAt) return undefined;
  if (Number(expiresAt) <= Math.floor(now.getTime() / 1000)) return undefined;

  return userId;
}
