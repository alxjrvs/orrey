import type { AttendanceRow } from "./render.ts";
import type { ProjectionTarget } from "../projection/target.ts";

/**
 * Does it run.
 *
 * Quorum is click-driven, which is why it fits send-only for free: the tally
 * only changes when somebody votes, and that vote is an interaction with a
 * fresh token, so the click that crosses the threshold is the click that renders
 * the confirmed state. Nothing has to go back and edit anything.
 *
 * A campaign with no quorum set has no threshold to cross. That is not "quorum
 * of zero" — it is a campaign that has not been asked the question, and it never
 * confirms on its own.
 */
export interface Quorum {
  /** How many `in` it takes. Null when the campaign has not said. */
  required: number | null;
  /** How many there are. */
  saidIn: number;
  /** Whether the count is at or above the threshold, right now. */
  met: boolean;
  /** Whether the session has been confirmed at some point. */
  confirmed: boolean;
  /**
   * Confirmed, and since fallen below. The post says so and nothing else
   * happens: whether that un-confirms the session is the organiser's call, and
   * #28 is explicit that Orrey surfaces it rather than deciding it.
   */
  slipped: boolean;
}

export function quorumOf(target: ProjectionTarget, rows: AttendanceRow[]): Quorum {
  const required = target.campaign?.quorum ?? null;
  const saidIn = rows.filter((row) => row.intent === "in").length;
  const met = required !== null && saidIn >= required;
  const confirmed = target.session.state === "CONFIRMED";

  return { required, saidIn, met, confirmed, slipped: confirmed && !met };
}

/**
 * Whether this click is the one that crosses the threshold. Only a session that
 * is still SCHEDULED confirms: a CANCELLED or PLAYED session is not waiting to
 * be confirmed, and a CONFIRMED one already is.
 */
export function crossesThreshold(quorum: Quorum, target: ProjectionTarget): boolean {
  return quorum.met && target.session.state === "SCHEDULED";
}

/** The line the post carries about all this, or nothing when there is no threshold. */
export function quorumLine(quorum: Quorum): string | undefined {
  const { required, saidIn, met, confirmed, slipped } = quorum;
  if (required === null) return undefined;

  if (slipped) {
    return `**Confirmed**, but ${saidIn} of ${required} are in now. Still on unless the GM says otherwise.`;
  }
  if (confirmed || met) return `**Confirmed** — ${saidIn} of ${required} in.`;
  return `${saidIn} of ${required} in.`;
}
