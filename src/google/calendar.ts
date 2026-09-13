import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { googleFingerprint, sessionTitle, type ProjectionTarget } from "../projection/target.ts";
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
  if (link?.fingerprint === fingerprint) return;

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
  return {
    id: eventId,
    summary: sessionTitle(target),
    ...(session.location ? { location: session.location } : {}),
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

/** The one calendar Orrey writes to. Never a calendar id from anywhere else. */
function calendarId(env: Env): string {
  if (!env.GOOGLE_CALENDAR_ID) throw new Error("GOOGLE_CALENDAR_ID is not set");
  return encodeURIComponent(env.GOOGLE_CALENDAR_ID);
}

function isoOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
