import { fingerprint } from "../projection/fingerprint.ts";
import { googleProjectedContent } from "../projection/target.ts";
import type { CalendarEvent } from "./sync.ts";

/**
 * Whether Orrey is looking at its own handwriting.
 *
 * This is the heart of #48 and the reason the return path is six PRs: everything
 * else in the loop is plumbing, and this is the one function that can make the
 * loop never terminate. An echo that stops being recognised is an infinite loop;
 * a change misread as an echo is a drag in Google that Orrey silently reverts.
 *
 * Pure, and takes no clock and no database, so every verdict in this file is a
 * function of three values a test can write down.
 */
export type Verdict = "echo" | "changed" | "deleted" | "foreign";

export interface LinkRow {
  sessionId: string;
  gcalEventId: string;
  fingerprint: string | null;
}

/** The three fields of a session this comparison needs, and no more. */
export interface SessionShape {
  id: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  state: string;
}

/**
 * Which session an event belongs to, if any.
 *
 * `extendedProperties.private.orreySessionId` is what `eventBody` writes, so it
 * is the first answer. `calendar_links.gcal_event_id` is the fallback for an
 * event that predates the property, or one whose properties somebody stripped.
 *
 * **An event with neither is `foreign` and is left entirely alone.** People put
 * things on this calendar too, and the whole design of owning a calendar rather
 * than filtering somebody else's is undone the moment Orrey starts editing rows
 * it did not write.
 */
export function sessionIdOf(event: CalendarEvent, links: LinkRow[]): string | undefined {
  const declared = event.extendedProperties?.private?.orreySessionId;
  if (declared) return declared;
  return links.find((link) => link.gcalEventId === event.id)?.sessionId;
}

export async function classifyEvent(
  event: CalendarEvent,
  link: LinkRow | undefined,
  session: SessionShape | undefined,
): Promise<Verdict> {
  // Nothing of Orrey's behind it. Somebody else's evening on a shared calendar.
  if (!link || !session) return "foreign";

  // Google's word for gone. It says nothing about whether the session is off —
  // that is #48's rule, and the handler one PR up puts the event back.
  if (event.status === "cancelled") return "deleted";

  // The comparison is against a fingerprint recomputed from what the event now
  // shows — never against `extendedProperties.private.orreyFingerprint`.
  //
  // That property is written by `eventBody` and a human dragging an event leaves
  // it untouched, so trusting it would call every real change an echo of
  // Orrey's own write: the exact failure this phase exists to prevent, reached
  // by the more convenient route. It stays written because it is useful when
  // reading the calendar by hand, and it is never read here.
  const recomputed = await fingerprint(shapeOf(event, session));
  return recomputed === link.fingerprint ? "echo" : "changed";
}

/**
 * The same five fields `googleProjectedContent` produces, in the same shape,
 * rebuilt from what Google now shows.
 *
 * These two must not drift. The fingerprint stored by the projector was computed
 * from `googleProjectedContent`; if this built a different shape, no event would
 * ever match and every pass would call everything `changed` — which is the
 * infinite loop, arrived at from the other side. They are written to be read
 * together, and the test for this compares against `googleProjectedContent`
 * directly rather than against a literal.
 *
 * **Four fields come off the event. `state` comes off the session row**, because
 * state does not exist in Google at all. That asymmetry is deliberate and is
 * exactly #48's rule that Google never cancels a session: an event has no way to
 * disagree about state, so it cannot.
 *
 * Attendee `responseStatus` is read nowhere in this file. It is not an RSVP and
 * never will be.
 */
export function shapeOf(
  event: CalendarEvent,
  session: SessionShape,
): ReturnType<typeof googleProjectedContent> {
  return {
    title: event.summary ?? "",
    startsAt: secondsOf(event.start) ?? session.startsAt,
    endsAt: secondsOf(event.end) ?? session.endsAt,
    location: event.location ?? null,
    state: session.state,
  } as ReturnType<typeof googleProjectedContent>;
}

/**
 * Google gives a timed event `dateTime` and an all-day event `date`. Orrey only
 * ever writes the first, so a `date` is somebody having turned one of its events
 * into an all-day — which is a change, and is read as the day's start.
 */
function secondsOf(when: { dateTime?: string; date?: string } | undefined): number | undefined {
  const iso = when?.dateTime ?? (when?.date ? `${when.date}T00:00:00Z` : undefined);
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
