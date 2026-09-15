import type { Env } from "../env.ts";

/**
 * The console session, carried in a signed cookie rather than a table.
 *
 * There is nothing in it but a Discord id and an expiry, because there is
 * nothing else it may be trusted for: roles are read with the bot token on every
 * request that needs them, so a stale cookie cannot carry a stale permission.
 *
 * `HttpOnly` so script cannot read it, `Secure` so it never crosses plaintext,
 * `SameSite=Lax` so a form on another origin cannot act as the user while still
 * letting the OAuth redirect arrive with it, and `Path=/` because the API and
 * the SPA are the same origin by design.
 */
export const SESSION_COOKIE = "orrey_session";
export const STATE_COOKIE = "orrey_oauth_state";

/** A week, matching Discord's own access-token lifetime. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;
/** Long enough to log in, short enough that a leaked link is not a key. */
const STATE_SECONDS = 10 * 60;

/**
 * Everything signed with this key names what it is for, and the purpose is
 * *inside* the signed bytes.
 *
 * Without that, two things signed over the same shape of payload with the same
 * key are interchangeable — a short-lived token meant only to start a login
 * would be a valid session cookie, and it travels in a URL, where a browser
 * puts it in history and a link preview fetches it. The prefix is what makes
 * "this is a session" a thing the signature attests to rather than a thing the
 * reader assumes.
 */
export type Purpose = "session" | "login";

export async function issueSession(env: Env, userId: string, now: Date): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${await sign(env, "session", payload)}`;
}

/**
 * The id in a cookie that is both unexpired and genuinely ours, or undefined.
 *
 * Undefined is the only failure mode on purpose: a tampered cookie, an expired
 * one and a missing one are all "not logged in", and distinguishing them in the
 * response tells an attacker which half of the guess was right.
 */
export async function readSession(
  env: Env,
  cookie: string | undefined,
  now: Date,
): Promise<string | undefined> {
  if (!cookie) return undefined;

  const cut = cookie.lastIndexOf(".");
  if (cut < 0) return undefined;

  const payload = cookie.slice(0, cut);
  const signature = cookie.slice(cut + 1);
  if (!(await verify(env, "session", payload, signature))) return undefined;

  const [userId, expiresAt] = payload.split(".");
  if (!userId || !expiresAt) return undefined;
  if (Number(expiresAt) <= Math.floor(now.getTime() / 1000)) return undefined;

  return userId;
}

export function sessionCookie(value: string): string {
  return attributes(`${SESSION_COOKIE}=${value}`, SESSION_SECONDS);
}

export function stateCookie(value: string): string {
  return attributes(`${STATE_COOKIE}=${value}`, STATE_SECONDS);
}

/** Same attributes, zero age: the only way a Set-Cookie removes one. */
export function clear(name: string): string {
  return attributes(`${name}=`, 0);
}

function attributes(pair: string, maxAge: number): string {
  return `${pair}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

/** 128 bits. Used for the OAuth `state`, which exists only to be unguessable. */
export function mintState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function key(env: Env): Promise<CryptoKey> {
  if (!env.CONSOLE_SESSION_SECRET) throw new Error("CONSOLE_SESSION_SECRET is not set");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CONSOLE_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sign(env: Env, purpose: Purpose, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await key(env),
    new TextEncoder().encode(`${purpose}:${payload}`),
  );
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `crypto.subtle.verify` rather than comparing strings: a `===` on a MAC leaks
 * how many leading bytes were right, one request at a time.
 */
export async function verify(
  env: Env,
  purpose: Purpose,
  payload: string,
  signature: string,
): Promise<boolean> {
  const bytes = signature.match(/../g);
  if (!bytes || bytes.length !== 32) return false;

  return crypto.subtle.verify(
    "HMAC",
    await key(env),
    Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 16)),
    new TextEncoder().encode(`${purpose}:${payload}`),
  );
}
