import type { AttendanceRow } from "./render.ts";
import type { ProjectionTarget } from "../projection/target.ts";

/**
 * Does it run.
 *
 * **Two rules**, and which one answers is a fact about the session rather than a
 * setting somebody picked:
 *
 * - **Before there is a roster**, the question is *how many*. A campaign still
 *   forming, a game day looking for players — nobody is assigned yet, so the
 *   only thing a count can mean is a bar being cleared. That is `quorum`, and it
 *   is everything this file used to do.
 * - **Once there is a roster**, the question is *does anybody object*. The people
 *   coming are the people assigned to come, so counting them is beside the
 *   point: five players with four in is not four fifths of a session, it is a
 *   table waiting on one person. Silence is in, and one `out` moves the evening
 *   rather than shrinking it.
 *
 * The second is the veto default, and #173 is where it comes from. It is
 * **derived and never stored**, so a campaign cannot be half-way between the two
 * and there is no column to fall out of step — which matters more than usual
 * here, because rebuilding `campaigns` to add one would cascade-delete every
 * session (docs/GOTCHAS.md).
 *
 * `campaigns.quorum` is the opt-out, and the only one. Setting it is how an
 * organiser says "no — count them", which is what that column has always meant;
 * reusing it keeps a campaign's answer to "does it run" in one place rather than
 * two that can disagree.
 *
 * Quorum is click-driven, which is why it fits send-only for free: the tally only
 * changes when somebody votes, and that vote is an interaction with a fresh
 * token, so the click that crosses the threshold is the click that renders the
 * confirmed state. Nothing has to go back and edit anything. The veto rule is the
 * same shape for the same reason — a veto is a click too.
 */
export type RuleKind = "quorum" | "unanimous";

export interface Quorum {
  /** Which of the two questions this session is asking. */
  rule: RuleKind;
  /**
   * How many `in` it takes, under `quorum`. Null when the campaign has not said —
   * and null under `unanimous`, where there is no number at all: "nobody
   * objects" is not a count of anything.
   */
  required: number | null;
  /** How many there are. */
  saidIn: number;
  /** How many people the session is for. Zero when nobody is assigned to it. */
  roster: number;
  /**
   * Who is holding it up, under `unanimous` — and only people on the roster,
   * because a veto is a seat saying it cannot make the date. Somebody who
   * answered `out` and has since left the table is not standing in the way of an
   * evening that is no longer theirs.
   *
   * Always empty under `quorum`, where an `out` is simply not an `in`.
   */
  vetoes: string[];
  /** Whether the rule says it runs, right now. */
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

/**
 * How many `in` it takes, asked of whichever parent the session has.
 *
 * A campaign says so itself — `campaigns.quorum`, set by the organiser. A
 * `single` game day does not have that column and does not need one: the game
 * already says how few people can play it, and `games.min_players` is the same
 * number phase 4's default win rule used. A `multi` day is a hangout and has no
 * threshold at all; neither does a day playing a game whose minimum nobody has
 * filled in.
 *
 * Null is "nobody has asked this question", not "a quorum of zero". A session
 * with no threshold never confirms on its own and is never in jeopardy.
 *
 * Under the veto rule this is not the question being asked, and `quorumOf`
 * does not call it. It stays the answer to "how many", which is what the
 * jeopardy notice and the console's quorum field are still asking for.
 */
export function requiredFor(target: ProjectionTarget): number | null {
  if (target.campaign) return target.campaign.quorum ?? null;
  if (target.gameDay?.kind === "single") return target.game?.minPlayers ?? null;
  return null;
}

/**
 * Whether the roster is established — which is the whole of "which rule".
 *
 * Four conditions, and every one of them is load-bearing:
 *
 * - **A campaign.** A game day is the other rule by construction: it exists to
 *   find out who is coming, and `games.min_players` is the bar it is looking
 *   for. There is nothing unanimous about a hangout.
 * - **Past FORMING.** A forming campaign's roster is its *claimants*, and a claim
 *   is an expression of interest rather than a seat. Letting one of them veto the
 *   first session would let somebody who has not started playing move a date for
 *   the people who have.
 * - **Somebody on it.** Unanimity across nobody is vacuously true, and "it runs
 *   because there was nobody to object" is exactly the number-computed-from-
 *   nothing this repo keeps refusing to ship. A RUNNING campaign with an empty
 *   roster falls back to quorum — which, unset, is "nobody has asked". Orrey
 *   says nothing rather than something wrong, and the fix is entering the roster.
 * - **No quorum set.** The opt-out above.
 */
function isUnanimous(target: ProjectionTarget, roster: number): boolean {
  const { campaign } = target;
  return (
    campaign !== null && campaign.state !== "FORMING" && campaign.quorum === null && roster > 0
  );
}

export function quorumOf(target: ProjectionTarget, rows: AttendanceRow[]): Quorum {
  const roster = rows.filter((row) => row.onRoster).length;
  const saidIn = rows.filter((row) => row.intent === "in").length;
  const confirmed = target.session.state === "CONFIRMED";

  if (isUnanimous(target, roster)) {
    const vetoes = rows
      .filter((row) => row.onRoster && row.intent === "out")
      .map((row) => row.userId);
    const met = vetoes.length === 0;

    return {
      rule: "unanimous",
      // There is no threshold under this rule, and reporting the roster size as
      // one would make every surface render "3 of 5 in" over a session that is
      // on — which is the reading this phase exists to stop.
      required: null,
      saidIn,
      roster,
      vetoes,
      met,
      confirmed,
      slipped: confirmed && !met,
    };
  }

  const required = requiredFor(target);
  const met = required !== null && saidIn >= required;

  return {
    rule: "quorum",
    required,
    saidIn,
    roster,
    vetoes: [],
    met,
    confirmed,
    slipped: confirmed && !met,
  };
}

/**
 * Whether this click is the one that crosses the threshold.
 *
 * A session that is still waiting to be confirmed is one of two things:
 * SCHEDULED, or **JEOPARDY**. Being marked short a day out is not a terminal
 * state — it is a question asked of the table — and the whole point of asking is
 * that somebody might answer by turning up. A JEOPARDY session that reaches
 * quorum is exactly the good outcome, and refusing to confirm it would leave a
 * post reading "Confirmed" over a session the database says is in jeopardy, for
 * ever, with no click able to fix it.
 *
 * CANCELLED and PLAYED are not waiting for anything, and a CONFIRMED one already
 * is.
 *
 * **Under the veto rule there is no crossing at all.** A session with a roster
 * and no objection is on from the moment it is made, so there is no unconfirmed
 * state for a click to take it out of, and writing CONFIRMED anyway would post
 * "It's on" about a session whose own post has said exactly that all along. That
 * rule moves a session in one direction only, and `vetoed` is that direction.
 */
const WAITING = new Set(["SCHEDULED", "JEOPARDY"]);

export function crossesThreshold(quorum: Quorum, target: ProjectionTarget): boolean {
  return quorum.rule === "quorum" && quorum.met && WAITING.has(target.session.state);
}

/**
 * Whether the evening as scheduled has stopped working: somebody on the roster
 * cannot make it, on a session that has not finished being decided.
 *
 * **JEOPARDY is here**, and it is worth saying why, because "a session already
 * marked has already been acted on" is the obvious reading and it is wrong twice
 * over. A session moved by a date poll keeps the JEOPARDY it was marked with —
 * `moveSession` changes the date and not the state — so excluding it would mean a
 * campaign got exactly one reschedule ever, and a veto of the *new* date did
 * nothing at all. And a session the clock marked a day out has had nothing acted
 * on: the notice says a date poll is the next step, and this is what takes it.
 *
 * What stops two polls about one evening is not this set. It is
 * `date_polls_one_open_per_session`, the partial unique index — the same lock
 * `/reschedule` races against — which holds across a restart, a retry and two
 * clicks in the same second, none of which a state check does.
 *
 * LOCKED, CANCELLED and PLAYED cannot get here at all: `takesIntent` refuses the
 * click before it reaches the tally.
 */
const UNSETTLED = new Set(["SCHEDULED", "CONFIRMED", "JEOPARDY"]);

export function vetoed(quorum: Quorum, target: ProjectionTarget): boolean {
  return (
    quorum.rule === "unanimous" && quorum.vetoes.length > 0 && UNSETTLED.has(target.session.state)
  );
}

/** The line the post carries about all this, or nothing when there is no rule to state. */
export function quorumLine(quorum: Quorum): string | undefined {
  const { rule, required, saidIn, roster, vetoes, met, confirmed, slipped } = quorum;

  /**
   * Under the veto rule the line is the rule, not a tally — because the tally is
   * not what decides. It says what silence means, which is the one thing a
   * reader has to know before deciding whether to click anything.
   */
  if (rule === "unanimous") {
    if (!met) {
      const who = vetoes.length === 1 ? "one person" : `${vetoes.length} people`;
      return `**Can't run as it stands** — ${who} out of ${roster}. A date poll is the next step.`;
    }
    return `**On** — ${roster} on the roster, nobody out. Silence counts as in; press **Out** if you cannot make it.`;
  }

  if (required === null) return undefined;

  if (slipped) {
    return `**Confirmed**, but ${saidIn} of ${required} are in now. Still on unless the GM says otherwise.`;
  }
  if (confirmed || met) return `**Confirmed** — ${saidIn} of ${required} in.`;
  return `${saidIn} of ${required} in.`;
}
