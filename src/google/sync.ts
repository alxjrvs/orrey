import { sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, clearSetting, getSetting, setSetting } from "../db/settings.ts";
import { GoogleError, accessToken, watchCalendarId } from "./calendar.ts";

/**
 * Asking Google what is on the calendar.
 *
 * This file knows how to ask and nothing about what any of it means:
 * classification and every write to `sessions` or `calendar_links` arrive in the
 * PRs above.
 *
 * **The list carries no `timeMin`, no `q` and no `privateExtendedProperty`.**
 * `syncToken` is incompatible with all three — Google rejects the combination —
 * and that incompatibility is the platform constraint that made Orrey own a
 * calendar in the first place. Listing everything is the design, not a shortcut,
 * and anybody reaching for a filter here should read this paragraph first: the
 * filter is what the separate calendar buys.
 */
const API = "https://www.googleapis.com/calendar/v3";

/** Google's cap; asking for more is ignored, asking for fewer is more pages. */
const PAGE_SIZE = 250;

export const SYNC_JOB = "gcal.sync";

/**
 * The trigger for the one path in the system that can loop.
 *
 * A push from Google arms a **job**, not a queue message, for the reason the
 * `jobs` table exists at all: when this edge goes wrong it has to be
 * inspectable and re-runnable by hand.
 *
 * The idempotency key is the minute. A single drag in Google produces a burst of
 * pushes, and they collapse into one sync by the unique constraint on
 * `jobs.idempotency_key` rather than by a lock.
 */
export async function armSync(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const minute = Math.floor(now / 60);
  const id = `${SYNC_JOB}:${minute}`;

  await db(env)
    .insert(schema.jobs)
    .values({
      id,
      kind: SYNC_JOB,
      payload: { minute },
      idempotencyKey: id,
      runAt: sql`(unixepoch())`,
    })
    .onConflictDoNothing();
}

/** What Google returns, narrowed to the fields anything downstream will read. */
export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  updated?: string;
}

export interface Listing {
  events: CalendarEvent[];
  /** Whether this run started from scratch, because Google expired the cursor. */
  full: boolean;
}

/**
 * Every page of what has changed since the stored cursor, or the whole calendar
 * when there is no cursor.
 *
 * The new `nextSyncToken` is stored **only when the last page arrives**. Google
 * returns one on the final page and a `nextPageToken` on every other, so storing
 * a cursor mid-pagination would skip everything on the pages not yet read.
 */
export async function listCalendar(env: Env): Promise<Listing> {
  const stored = await getSetting<string>(env, SETTING_KEYS.googleSyncToken);

  try {
    return await pages(env, stored);
  } catch (error) {
    // Google expires sync tokens on its own schedule, so this is ordinary
    // rather than exceptional — a path with a test, not a log line. Clear the
    // cursor and list the whole calendar, in this same call: a sync that
    // answered "410" and stopped would need a second push to recover, and the
    // push that would have caused one has already been collapsed away.
    if (!(error instanceof GoogleError) || error.status !== 410) throw error;

    await clearSetting(env, SETTING_KEYS.googleSyncToken);
    const listing = await pages(env, undefined);
    return { ...listing, full: true };
  }
}

async function pages(env: Env, syncToken: string | undefined): Promise<Listing> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const query = new URLSearchParams({ maxResults: String(PAGE_SIZE), showDeleted: "true" });
    // `showDeleted` is how a cancelled event arrives at all: without it a
    // deletion is simply an event that stopped being listed, which is
    // indistinguishable from one that was never there.
    if (syncToken) query.set("syncToken", syncToken);
    if (pageToken) query.set("pageToken", pageToken);

    const page = (await googleFetch(
      env,
      `/calendars/${watchCalendarId(env)}/events?${query.toString()}`,
    )) as { items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string };

    events.push(...(page.items ?? []));

    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }

    // The last page. Only now is there a cursor that covers everything read.
    if (page.nextSyncToken) {
      await setSetting(env, SETTING_KEYS.googleSyncToken, page.nextSyncToken);
    }
    return { events, full: syncToken === undefined };
  }
}

/**
 * What the sync job does: ask, and — for now — nothing else.
 *
 * Interpreting the answer arrives in `p7/11`. Listing is worth landing on its
 * own because it is the half that talks to Google, and a review of "does this
 * page correctly" is a different review from "does this mean what we think".
 */
export async function runSync(env: Env): Promise<void> {
  await listCalendar(env);
}

async function googleFetch(env: Env, path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${await accessToken(env)}` },
  });

  if (!response.ok) {
    throw new GoogleError(response.status, `GET ${path} -> ${response.status}`);
  }
  return await response.json();
}
