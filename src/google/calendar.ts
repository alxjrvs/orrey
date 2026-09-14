import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import {
  googleFingerprint,
  locationOf,
  sessionTitle,
  type ProjectionTarget,
} from "../projection/target.ts";
import {
  find,
  record,
  retract,
  standing,
  type PublicationRef,
} from "../projection/publications.ts";
import { serviceAccountToken, type AccessToken } from "./auth.ts";
import { eventIdFor } from "./event-id.ts";

/**
 * The Google projection. Writes go to **the Orrey calendar and nowhere else** —
 * every request in this file is built from `GOOGLE_CALENDAR_ID`, and there is
 * no code path that takes a calendar id from anywhere but the environment. The
 * user's own Social calendar is read by people, never written by Orrey.
 *
 * The upsert is `insert`, and on `409` `update`, against an id Orrey mints from
 * the session id — so a redelivered queue message lands on the same event and
 * there is no lookup to get wrong.
 */
const API = "https://www.googleapis.com/calendar/v3";

/**
 * A service-account token has no refresh token behind it: there is nothing to
 * expire or re-consent, so the isolate can hold one for its lifetime and mint
 * another when it lapses.
 */
let cached: AccessToken | undefined;

export async function accessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.accessToken;

  cached = await serviceAccountToken({
    clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
  });
  return cached.accessToken;
}

/** For tests, and for the day the service account's key is rotated. */
export function clearTokenCache(): void {
  cached = undefined;
}

export class GoogleError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

export async function projectGoogleEvent(
  env: Env,
  target: ProjectionTarget,
  kind: "gcal.upsert" | "gcal.delete",
): Promise<void> {
  const eventId = await eventIdFor(target.session.id);
  try {
    if (kind === "gcal.delete") return await unproject(env, target, eventId);
    return await upsert(env, target, eventId);
  } catch (error) {
    // The row is the record of what went wrong, next to the id it went wrong
    // on. The throw still stands, so the queue retries and the DLQ catches it —
    // and recording must never replace it, or the DLQ ends up naming D1 for a
    // failure that happened at Google.
    try {
      await recordFailure(env, target.session.id, eventId, String(error));
    } catch (recordingFailed) {
      console.error("could not record the projection failure", recordingFailed);
    }
    throw error;
  }
}

/** This session's entry in the ledger of what Orrey has put into the world. */
function refFor(sessionId: string): PublicationRef {
  return { surface: "google", kind: "event", targetId: sessionId };
}

async function upsert(env: Env, target: ProjectionTarget, eventId: string): Promise<void> {
  const { session } = target;
  const fingerprint = await googleFingerprint(target);

  const link = await db(env)
    .select()
    .from(schema.calendarLinks)
    .where(eq(schema.calendarLinks.sessionId, session.id))
    .get();

  // Unchanged since the last successful write: skip. Google's `updated` moves
  // on every write, and phase 7's return path has to tell Orrey's own echo from
  // a person's edit — so a pointless write is worse here than a wasted call.
  //
  // The *write* is skippable; the record of it is not. Every session linked
  // before this table existed matches on its fingerprint and would never reach
  // `record` below — so the ledger would stay empty for exactly the sessions
  // that already exist, and a retraction after one of them is deleted would find
  // nothing standing and leave the event on the calendar forever. Which is #73,
  // unfixed, for the only sessions that have it.
  if (link?.fingerprint === fingerprint) {
    await ensureRecorded(env, session.id, eventId);
    return;
  }

  const body = eventBody(target, eventId, fingerprint);

  try {
    await googleFetch(env, `/calendars/${calendarId(env)}/events`, { method: "POST", body });
  } catch (error) {
    // 409: the id is taken, which means it is taken by this same session's
    // event — the id is derived from the session id and nothing else.
    if (!(error instanceof GoogleError && error.status === 409)) throw error;
    await googleFetch(env, `/calendars/${calendarId(env)}/events/${eventId}`, {
      method: "PUT",
      body,
    });
  }

  // `calendar_links` cascades off `sessions`; the ledger does not. Both are
  // written, and only one of them still exists after the session row goes.
  await record(env, refFor(session.id), eventId);

  await db(env)
    .insert(schema.calendarLinks)
    .values({
      sessionId: session.id,
      gcalEventId: eventId,
      fingerprint,
      syncedAt: sql`(unixepoch())`,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: schema.calendarLinks.sessionId,
      set: { gcalEventId: eventId, fingerprint, syncedAt: sql`(unixepoch())`, lastError: null },
    });
}

async function unproject(env: Env, target: ProjectionTarget, eventId: string): Promise<void> {
  try {
    await googleFetch(env, `/calendars/${calendarId(env)}/events/${eventId}`, { method: "DELETE" });
  } catch (error) {
    // 404/410: already gone, which is the outcome asked for.
    if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) throw error;
  }

  await retract(env, refFor(target.session.id));

  await db(env)
    .delete(schema.calendarLinks)
    .where(eq(schema.calendarLinks.sessionId, target.session.id));
}

/**
 * `extendedProperties.private` is how phase 7 finds Orrey's own events again —
 * and the fingerprint stored beside the session id is what lets it tell an echo
 * of Orrey's own write from a human moving the event in Google.
 */
export function eventBody(
  target: ProjectionTarget,
  eventId: string,
  fingerprint: string,
): Record<string, unknown> {
  const { session } = target;
  // The same helper the fingerprint and the Discord body read. Reading
  // `session.location` here instead left every game day's Google event with no
  // place on it — the venue lives on `game_days.venue`, and a day's session is
  // minted with `location` null — while the fingerprint hashed the venue in and
  // claimed it had. Moving a venue then changed the fingerprint, missed the skip
  // guard, and wrote a body byte-identical to the one already there, moving
  // `updated` for a field the surface never showed. That is precisely the thing
  // `locationOf`'s own docstring says phase 7's return path must not have to
  // explain.
  const location = locationOf(target);
  return {
    id: eventId,
    summary: sessionTitle(target),
    ...(location ? { location } : {}),
    start: { dateTime: isoOf(session.startsAt), timeZone: "UTC" },
    end: { dateTime: isoOf(session.endsAt), timeZone: "UTC" },
    extendedProperties: {
      private: { orreySessionId: session.id, orreyFingerprint: fingerprint },
    },
  };
}

async function recordFailure(
  env: Env,
  sessionId: string,
  eventId: string,
  message: string,
): Promise<void> {
  await db(env)
    .insert(schema.calendarLinks)
    .values({ sessionId, gcalEventId: eventId, lastError: message })
    .onConflictDoUpdate({ target: schema.calendarLinks.sessionId, set: { lastError: message } });
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
    throw new GoogleError(
      response.status,
      `${init.method} ${path} -> ${response.status} ${await response.text()}`.trim(),
    );
  }
  return response.status === 204 ? undefined : await response.json();
}

/**
 * The one calendar Orrey watches, which is the one calendar it writes to.
 *
 * Exported so `src/google/watch.ts` opens its channel under the same rule
 * instead of restating it — one place that knows which calendar is Orrey's, and
 * therefore one place that could ever get it wrong.
 */
export function watchCalendarId(env: Env): string {
  return calendarId(env);
}

/** The one calendar Orrey writes to. Never a calendar id from anywhere else. */
function calendarId(env: Env): string {
  if (!env.GOOGLE_CALENDAR_ID) throw new Error("GOOGLE_CALENDAR_ID is not set");
  return encodeURIComponent(env.GOOGLE_CALENDAR_ID);
}

function isoOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * The Google half of retracting without the session row. Google's id is derived
 * from the session id, so this could be done from the id alone — but reading the
 * ledger is what keeps the two surfaces answering the same question, and it is
 * what stops Orrey issuing a DELETE for an event it never actually published.
 */
export async function unprojectOrphanedEvent(env: Env, sessionId: string): Promise<void> {
  for (const row of await standing(env, sessionId)) {
    if (row.surface !== "google" || !row.remoteId) continue;

    try {
      await googleFetch(env, `/calendars/${calendarId(env)}/events/${row.remoteId}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) {
        throw error;
      }
    }
    await retract(env, { surface: "google", kind: "event", targetId: sessionId });
  }
}

/**
 * Backfill, run on the skip path: the ledger learns about an event that was
 * published before there was a ledger to write it to. A read first, because the
 * skip path is the common one and this must not turn every no-op projection into
 * a write.
 */
async function ensureRecorded(env: Env, sessionId: string, eventId: string): Promise<void> {
  const ref = refFor(sessionId);
  const known = await find(env, ref);
  if (known?.state === "published" && known.remoteId === eventId) return;
  // A retraction is a decision, not a gap. Do not undo one by backfilling.
  if (known?.state === "retracted") return;
  await record(env, ref, eventId);
}
