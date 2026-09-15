import { sql } from "drizzle-orm";

/**
 * The one place `sessions.ics_sequence` rises.
 *
 * Spread into the `set` of whichever domain function moves or calls off a
 * session, so that grepping for `bumpIcsSequence` lists every caller and the
 * `+ 1` itself exists exactly once. A second increment written inline somewhere
 * would double-count for a client, which reads a sequence going 0 → 2 as having
 * missed an update it never got.
 *
 * A roster change is deliberately not one of the callers. `SEQUENCE` is about
 * the event — when it is and whether it is on — and a client re-prompting every
 * attendee because somebody clicked Maybe is a client nobody keeps subscribed.
 */
export const bumpIcsSequence = { icsSequence: sql`ics_sequence + 1` } as const;
