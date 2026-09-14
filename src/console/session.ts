import type { Env } from "../env.ts";
import { SESSION_COOKIE, readCookie, readSession } from "./cookies.ts";
import { forgetTokens, refresh, replaceTokens, storedTokens, type TokenPair } from "./oauth.ts";

/**
 * Who is asking, and are their Discord credentials still good.
 *
 * The cookie says who; `discord_tokens` says whether Orrey can still act as
 * them. Those are separate questions, and keeping them separate is what lets the
 * cookie carry almost nothing: a valid cookie whose token pair has been revoked
 * is not a session, and a valid cookie with a stale *access* token is, because
 * the refresh token is what that is for.
 */
export interface ConsoleSession {
  userId: string;
  accessToken: string;
}

/**
 * Refreshed a minute early, so a request that takes a moment does not set out
 * with a token that expires on the way.
 */
const EARLY_SECONDS = 60;

export async function sessionFrom(
  env: Env,
  cookieHeader: string | undefined,
  now: Date,
): Promise<ConsoleSession | undefined> {
  const userId = await readSession(env, readCookie(cookieHeader, SESSION_COOKIE), now);
  if (!userId) return undefined;

  const stored = await storedTokens(env, userId);
  if (!stored) return undefined;

  const seconds = Math.floor(now.getTime() / 1000);
  if (stored.expiresAt > seconds + EARLY_SECONDS) {
    return { userId, accessToken: stored.accessToken };
  }

  let renewed: TokenPair;
  try {
    renewed = await refreshOnce(env, userId, stored.refreshToken);
  } catch (error) {
    // Losing the race is not the same as being logged out, and the console makes
    // three API calls at once — so three requests can reach here holding the same
    // refresh token, and Discord rotates it, which means the two that arrive
    // second are refused for a token that was good when they read it. Look again
    // before concluding anything: if somebody else has already stored a fresh
    // pair, that is the answer, not a logout.
    const current = await storedTokens(env, userId);
    if (current && current.refreshToken !== stored.refreshToken) {
      return { userId, accessToken: current.accessToken };
    }

    // Nobody refreshed it. Discord refused the token that is still stored, so
    // this is a logged-out person rather than an error to retry into, and the
    // pair is dropped so the next request does not ask again with a token
    // Discord has already refused.
    console.error("console refresh failed", userId, error);
    await forgetTokens(env, userId);
    return undefined;
  }

  return { userId, accessToken: renewed.accessToken };
}

/**
 * One refresh per person at a time, per isolate.
 *
 * The console asks for three things at once, so three requests arrive holding
 * the same refresh token — and Discord *rotates* it, so the first exchange
 * retires the token the other two are about to present. They were then refused
 * for a token that was good when they read it, which blanked the page to "not
 * signed in" and could delete the winner's fresh pair on the way out.
 *
 * Collapsing them here fixes the common case exactly, because "the same page
 * loading" is one isolate. The re-read in the caller's catch covers the rest:
 * two isolates can still race, and losing a race is not being logged out.
 *
 * The write is inside the shared promise, so everyone who joins it sees a pair
 * that is already stored rather than one that is about to be.
 */
const inFlight = new Map<string, Promise<TokenPair>>();

function refreshOnce(env: Env, userId: string, refreshToken: string): Promise<TokenPair> {
  const existing = inFlight.get(userId);
  if (existing) return existing;

  const work = (async () => {
    const renewed = await refresh(env, refreshToken);
    // Discord rotates refresh tokens: this replaces *both* halves. Keeping the
    // old one is how somebody is logged out for good a week later. Only the pair
    // is written — a refresh knows the id and nothing else about the person, and
    // writing them through would blank their cached name.
    await replaceTokens(env, userId, renewed);
    return renewed;
  })().finally(() => inFlight.delete(userId));

  inFlight.set(userId, work);
  return work;
}
