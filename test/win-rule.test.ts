import { describe, expect, it } from "vitest";
import { decide, type Tally, type WinRule } from "../src/polls/win-rule.ts";

/**
 * What "winning" means. The one place in phase 4 where a judgement is encoded,
 * and the one thing every rule must agree on: a tie is returned whole.
 */
const tallies = (...yeses: number[]): Tally[] =>
  yeses.map((yes, i) => ({ pollDateId: `d${i}`, yes }));

function run(rule: WinRule, over: { threshold?: number; rosterSize?: number; yes?: number[] } = {}) {
  return decide({
    rule,
    threshold: over.threshold ?? null,
    rosterSize: over.rosterSize ?? 5,
    tallies: tallies(...(over.yes ?? [])),
  });
}

describe("min_players", () => {
  it("wins at the threshold, not past it", () => {
    expect(run("min_players", { threshold: 3, yes: [3, 2] }).won).toEqual(["d0"]);
  });

  it("says nothing won when nothing reached it", () => {
    expect(run("min_players", { threshold: 4, yes: [3, 2, 1] }).won).toEqual([]);
  });

  it("needs no roster at all", () => {
    // "Four people and we play" is a question about the people who answered, not
    // about how many could have.
    expect(run("min_players", { threshold: 2, rosterSize: 0, yes: [2] }).won).toEqual(["d0"]);
  });

  it("returns every date that cleared it", () => {
    expect(run("min_players", { threshold: 2, yes: [4, 2, 3] }).won).toEqual(["d0", "d1", "d2"]);
  });
});

describe("quorum_of_roster", () => {
  it("rounds the fraction up", () => {
    // A table of five at 0.6 needs three, not 3.0 and not two.
    const decision = run("quorum_of_roster", { threshold: 0.6, rosterSize: 5, yes: [3, 2] });
    expect(decision.required).toBe(3);
    expect(decision.won).toEqual(["d0"]);
  });

  it("never asks for less than one person", () => {
    expect(run("quorum_of_roster", { threshold: 0.01, rosterSize: 5, yes: [1, 0] }).required).toBe(
      1,
    );
  });

  it("does not divide by an empty roster", () => {
    const decision = run("quorum_of_roster", { threshold: 0.5, rosterSize: 0, yes: [3] });

    // A campaign nobody is on: nothing wins, rather than everything winning by
    // clearing a threshold of zero.
    expect(decision).toMatchObject({ required: null, won: [] });
  });
});

describe("best_available", () => {
  it("takes the top date", () => {
    expect(run("best_available", { yes: [1, 4, 2] }).won).toEqual(["d1"]);
  });

  it("returns a tie whole", () => {
    // A rule that quietly takes the first of several tied dates is a rule that
    // decides something the organiser should.
    expect(run("best_available", { yes: [3, 3, 3, 1] }).won).toEqual(["d0", "d1", "d2"]);
  });

  it("does not pick a date nobody can make", () => {
    // "Best available" out of nothing available is nothing.
    expect(run("best_available", { yes: [0, 0] }).won).toEqual([]);
  });

  it("says nothing about an empty poll", () => {
    expect(run("best_available", { yes: [] })).toMatchObject({ won: [], required: null });
  });
});

describe("organiser_picks", () => {
  it("proposes nothing, however the tallies land", () => {
    for (const yes of [[], [0], [9, 9, 9], [1, 2, 3]]) {
      expect(run("organiser_picks", { yes }).won).toEqual([]);
    }
  });

  it("has no threshold to report, because it has no opinion", () => {
    expect(run("organiser_picks", { threshold: 3, yes: [5] }).required).toBeNull();
  });
});

describe("every rule", () => {
  const rules: WinRule[] = [
    "min_players",
    "quorum_of_roster",
    "best_available",
    "organiser_picks",
  ];

  it("names itself back, so the post can say which one decided", () => {
    for (const rule of rules) expect(run(rule, { yes: [2] }).rule).toBe(rule);
  });

  it("returns ids and never a count, so the caller cannot mistake one for the other", () => {
    for (const rule of rules) {
      for (const id of run(rule, { threshold: 1, yes: [2, 2] }).won) {
        expect(typeof id).toBe("string");
      }
    }
  });

  it("is pure — same input, same answer", () => {
    for (const rule of rules) {
      const args = { threshold: 2, rosterSize: 4, yes: [2, 3] };
      expect(run(rule, args)).toEqual(run(rule, args));
    }
  });
});

describe("a rule with no number", () => {
  it("decides nothing rather than letting everything win", () => {
    // `win_threshold` is nullable and the console validates the rule's *name*
    // without checking that a rule needing a number was given one. Falling back
    // to zero meant every date cleared the bar, including dates nobody answered.
    expect(
      decide({
        rule: "min_players",
        threshold: null,
        rosterSize: 5,
        tallies: [
          { pollDateId: "d1", yes: 0 },
          { pollDateId: "d2", yes: 1 },
        ],
      }),
    ).toEqual({ rule: "min_players", required: null, won: [] });
  });

  it("says the same about a threshold of zero", () => {
    expect(
      decide({
        rule: "min_players",
        threshold: 0,
        rosterSize: 5,
        tallies: [{ pollDateId: "d1", yes: 0 }],
      }),
    ).toMatchObject({ required: null, won: [] });
  });

  it("still decides when it has one", () => {
    expect(
      decide({
        rule: "min_players",
        threshold: 2,
        rosterSize: 5,
        tallies: [
          { pollDateId: "d1", yes: 1 },
          { pollDateId: "d2", yes: 3 },
        ],
      }),
    ).toMatchObject({ required: 2, won: ["d2"] });
  });
});
