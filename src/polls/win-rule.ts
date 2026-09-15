/**
 * Four ways to decide a date has won.
 *
 * This is the one place in phase 4 where a judgement is encoded — what
 * "winning" means — so it is its own slice, to be read rather than skimmed on
 * the way to a permission check.
 *
 * No D1, no clock, no env. Tallies in, winning ids out.
 *
 * **Ties are returned whole.** A rule that quietly takes the first of several
 * tied dates is a rule that decides something the organiser should, and the
 * whole design of this phase is that the rule proposes and the organiser
 * disposes. Everything this returns is a *preselection* on the override view;
 * nothing here closes a poll.
 */
export type WinRule =
  | "min_players"
  | "quorum_of_roster"
  | "best_available"
  | "organiser_picks";

export interface Tally {
  pollDateId: string;
  yes: number;
}

export interface Decision {
  rule: WinRule;
  /** The dates the rule proposes. Empty is a real answer under every rule. */
  won: string[];
  /** What the rule needed, where it needed a number, so the post can say so. */
  required: number | null;
}

export function decide({
  rule,
  threshold,
  rosterSize,
  tallies,
}: {
  rule: WinRule;
  threshold: number | null;
  /** How many people could have answered. Zero is possible and must not divide. */
  rosterSize: number;
  tallies: Tally[];
}): Decision {
  switch (rule) {
    /**
     * A flat number, from the poll's own `win_threshold`. The commonest rule and
     * the one that needs no roster at all: "four people and we play".
     */
    case "min_players": {
      // A rule that needs a number and was given none decides nothing, which is
      // the same answer `quorum_of_roster` gives an empty roster. Falling back to
      // zero made *every* date win — including ones nobody said they could make —
      // and reported `required: 0` as though it were a real bar. A number
      // computed from nothing is the failure this repo keeps refusing to ship.
      if (threshold === null || threshold <= 0) return { rule, required: null, won: [] };
      return { rule, required: threshold, won: atOrAbove(tallies, threshold) };
    }

    /**
     * A fraction of the roster, rounded up: a table of five at 0.6 needs three,
     * not 3.0 and not two.
     *
     * A roster of zero is a campaign nobody is on, and the honest answer is that
     * nothing wins — not that everything does by clearing a threshold of zero.
     */
    case "quorum_of_roster": {
      if (rosterSize <= 0) return { rule, required: null, won: [] };
      const required = Math.max(1, Math.ceil(rosterSize * (threshold ?? 0)));
      return { rule, required, won: atOrAbove(tallies, required) };
    }

    /**
     * Whatever did best — and everything level with it. A date nobody can make
     * still does not win: "best available" out of nothing available is nothing.
     */
    case "best_available": {
      const best = Math.max(0, ...tallies.map((tally) => tally.yes));
      if (best <= 0) return { rule, required: null, won: [] };
      return { rule, required: best, won: atOrAbove(tallies, best) };
    }

    /**
     * Nothing. Under this rule there is no computed winner at all — the poll
     * exists to show the organiser the tallies, and the override view opens with
     * nothing preselected because the rule has no opinion to offer.
     */
    case "organiser_picks":
      return { rule, required: null, won: [] };
  }
}

function atOrAbove(tallies: Tally[], required: number): string[] {
  return tallies.filter((tally) => tally.yes >= required).map((tally) => tally.pollDateId);
}
