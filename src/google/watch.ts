import type { Env } from "../env.ts";
import { SETTING_KEYS, getSetting, setSetting } from "../db/settings.ts";
import { GoogleError, accessToken, watchCalendarId } from "./calendar.ts";

/**
 * The push channel on the Orrey calendar.
 *
 * Google's `events.watch` channels have a TTL of about a week and do not renew
 * themselves, so the whole of this file is "open one when there is none, replace
 * it before it lapses, and never leave a gap".
 *
 * **Order matters, in one direction only.** The new channel is recorded *before*
 * the old one is stopped. Two channels open at once means duplicate pushes for a
 * few minutes, which the sync path collapses anyway because a push carries no
 * body and only ever arms one job a minute. A gap means changes nobody hears
 * about, and nothing in the system would notice.
 *
 * The channel is opened on `GOOGLE_CALENDAR_ID` and there is no code path here
 * that takes a calendar id from anywhere else: the user's own Social calendar is
 * not reachable from this file.
 */
const API = "https://www.googleapis.com/calendar/v3";

/** Replace a channel with less than this left on it. */
const RENEW_WITHIN_SECONDS = 48 * 3600;

export interface Watch {
  channelId: string;
  resourceId: string;
  /** The channel's shared secret. Compared against every push; never logged. */
  token: string;
  /** Unix seconds. Google's own expiry, stored as it gave it. */
  expiresAt: number;
}

export function storedWatch(env: Env): Promise<Watch | undefined> {
  return getSetting<Watch>(env, SETTING_KEYS.googleWatch);
}

/**
 * Open a channel, record it, and stop whatever it replaced.
 *
 * Returns the watch now in force. The stop is last and its failure is swallowed:
 * a channel Google will not close is a channel that expires in under a week on
 * its own, and throwing here would lose the new one that is already recorded.
 */
export async function startWatch(env: Env): Promise<Watch> {
  const previous = await storedWatch(env);

  const channelId = crypto.randomUUID();
  const token = crypto.randomUUID();

  const opened = (await googleFetch(env, `/calendars/${watchCalendarId(env)}/events/watch`, {
    method: "POST",
    body: {
      id: channelId,
      type: "web_hook",
      address: `${origin(env)}/google/notifications`,
      token,
    },
  })) as { resourceId?: string; expiration?: string };

  if (!opened.resourceId) {
    throw new Error("Google opened a channel without a resource id, so there is nothing to stop");
  }

  const watch: Watch = {
    channelId,
    resourceId: opened.resourceId,
    token,
    // Google's expiration is milliseconds as a string. A channel with no stated
    // expiry is treated as a week out, which is its documented default — and
    // which the renewal window will act on well before it matters.
    expiresAt: opened.expiration
      ? Math.floor(Number(opened.expiration) / 1000)
      : Math.floor(Date.now() / 1000) + 7 * 86_400,
  };

  // Recorded first. Everything after this point is tidying.
  await setSetting(env, SETTING_KEYS.googleWatch, watch);

  if (previous) await stopWatch(env, previous);
  return watch;
}

/**
 * Close a channel. Best effort by design: a stop that fails is a channel that
 * expires on its own, and the caller has already recorded its replacement.
 */
export async function stopWatch(env: Env, watch: Watch): Promise<void> {
  try {
    await googleFetch(env, "/channels/stop", {
      method: "POST",
      body: { id: watch.channelId, resourceId: watch.resourceId },
    });
  } catch (error) {
    // 404 means it is already gone, which is the outcome asked for. Anything
    // else is a channel that will lapse by itself within the week.
    if (!(error instanceof GoogleError)) throw error;
  }
}

/**
 * The `watch-renew` tick's whole job.
 *
 * Opens a channel when there is none and replaces one inside the renewal window.
 * Running it twice in the same minute opens one channel the second time only if
 * the first left the stored expiry inside the window, which it does not — so the
 * tick is idempotent without a lock.
 */
export async function renewWatchIfDue(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<"opened" | "renewed" | "current"> {
  const watch = await storedWatch(env);
  if (!watch) {
    await startWatch(env);
    return "opened";
  }

  if (watch.expiresAt - now > RENEW_WITHIN_SECONDS) return "current";

  await startWatch(env);
  return "renewed";
}

function origin(env: Env): string {
  if (!env.PUBLIC_ORIGIN) throw new Error("PUBLIC_ORIGIN is not set");
  return env.PUBLIC_ORIGIN.replace(/\/+$/, "");
}

async function googleFetch(
  env: Env,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${await accessToken(env)}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    // The body is echoed for the status and the path, never the request — the
    // channel token is in the request and belongs in no log line.
    throw new GoogleError(response.status, `${init.method} ${path} -> ${response.status}`);
  }
  return response.status === 204 ? undefined : await response.json();
}
