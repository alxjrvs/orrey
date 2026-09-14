/**
 * The names the audit trail is written under.
 *
 * Every one of these is spelled **once**. A reader that matches on a string
 * literal silently stops counting the day the writer's spelling changes, and
 * "silently stops counting" is the worst failure a statistic has: the number
 * stays plausible. `p7/12-inbound-change` writes `SESSION_MOVED` from the other
 * line of this phase, which is exactly the kind of second writer that makes a
 * shared constant worth having.
 *
 * These are the two kinds the schedule statistics read. The rest of the trail
 * still spells its own action inline — they are moved here as something wants
 * to read them, not ahead of it.
 */

/** A session's date changed. Written wherever a session moves, by anybody. */
export const SESSION_MOVED = "session.move";

/**
 * A session reached its quorum and confirmed itself.
 *
 * Written by the clock rather than by a person, so its `actor_user_id` is null:
 * nobody decided this, the count did.
 */
export const SESSION_CONFIRMED = "session.confirm";
