import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueProjection } from "../projection/outbox.ts";
import { shapeOf, type SessionShape } from "./classify.ts";
import type { CalendarEvent } from "./sync.ts";

/**
 * Somebody changed an event Orrey owns. What Orrey does about it.
 *
 * Two cases, and the second is the one worth the review attention, because the
 * naive version of it never terminates.
 *
 * **D1 wins in both.** The session's state is never taken from Google — #48 is
 * explicit that Google never cancels a session — and the title is never adopted,
 * because the title is derived from the campaign and the session number and
 * adopting it would start a fight the projector wins on the next write anyway.
 */
export type ChangeOutcome = "moved" | "re-projected" | "nothing";

/**
 * Somebody deleted an event Orrey owns. **It comes back.**
 *
 * D1 is the source of truth, so a deletion on the calendar says nothing about
 * whether the session is happening — #48 is explicit, and nothing here touches
 * `sessions.state`.
 *
 * Clearing the fingerprint is the mechanism, not a tidy-up: `upsert` skips a
 * write whose fingerprint already matches, so without the clear the re-insert
 * would be skipped and the event would stay gone. An absent fingerprint is
 * exactly "we do not know what is out there", and it needs no column to say so.
 *
 * It comes back at the same id, because `src/google/event-id.ts` mints it from
 * the session id — so the re-insert is the ordinary `insert`, and on 409
 * `update`, path that already exists.
 */
export async function applyDeletion(env: Env, sessionId: string): Promise<"re-inserted"> {
  await db(env)
    .update(schema.calendarLinks)
    .set({ fingerprint: null })
    .where(eq(schema.calendarLinks.sessionId, sessionId));

  await enqueueProjection(env, sessionId, ["google"]);
  return "re-inserted";
}

export async function applyChange(
  env: Env,
  sessionId: string,
  event: CalendarEvent,
): Promise<ChangeOutcome> {
  const session = await db(env)
    .select({
      id: schema.sessions.id,
      startsAt: schema.sessions.startsAt,
      endsAt: schema.sessions.endsAt,
      location: schema.sessions.location,
      state: schema.sessions.state,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!session) return "nothing";

  const shown = shapeOf(event, session as SessionShape);
  const moved =
    shown.startsAt !== session.startsAt ||
    shown.endsAt !== session.endsAt ||
    (shown.location ?? null) !== session.location;

  if (moved) {
    // Behind the session's own lock: a drag in Google and a click on the post
    // are two writers to one session.
    //
    // `moveSession` is the same function a resolved poll and a reschedule call,
    // so this path gets the re-armed jobs, the audit row, the reschedule notice
    // and the re-projection that already exist rather than a second set that
    // could drift. The projector then rewrites the event with a fingerprint
    // computed from the new row — so the push *that* write provokes classifies
    // as `echo` and stops there. That is the whole termination argument.
    const lock = env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(sessionId));
    await lock.moveFromGoogle({
      sessionId,
      startsAt: shown.startsAt,
      endsAt: shown.endsAt,
      location: shown.location ?? null,
    });
    return "moved";
  }

  /**
   * Nothing Orrey adopts moved — somebody retyped the summary.
   *
   * The naive version of this case never terminates. The row is unchanged, so
   * `calendar_links.fingerprint` still matches what `googleFingerprint`
   * computes, so `upsert` skips the write, so Google keeps the retyped summary,
   * so the next pass classifies it `changed` again, and again, forever.
   *
   * Clearing the fingerprint is what makes the next upsert unskippable. It is
   * the mechanism, not a tidy-up: an absent fingerprint means "we do not know
   * what is out there", which is exactly true here.
   *
   * No notice and no audit row, because nothing moved. Telling a thread that
   * somebody retyped a summary Orrey is about to overwrite is noise.
   */
  await db(env)
    .update(schema.calendarLinks)
    .set({ fingerprint: null })
    .where(eq(schema.calendarLinks.sessionId, sessionId));

  await enqueueProjection(env, sessionId, ["google"]);
  return "re-projected";
}
