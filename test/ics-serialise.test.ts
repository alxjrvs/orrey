import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { eventIdFor } from "../src/google/event-id.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { icsEventFor } from "../src/ics/event.ts";
import {
  escapeText,
  fold,
  localStamp,
  offsetAt,
  serialise,
  vtimezone,
  type IcsEvent,
} from "../src/ics/serialise.ts";
import { moveSession } from "../src/polls/move.ts";

/**
 * The calendar text.
 *
 * Every one of the RFC 5545 details below fails *silently* in a calendar client:
 * an over-long line, a comma nobody escaped, an LF where a CRLF belongs. None of
 * them raises anything — they produce an event that quietly is not there. So
 * they are asserted one by one rather than through a round trip that would pass
 * on a lenient parser.
 */
const STAMP = Math.floor(Date.parse("2026-09-14T12:00:00Z") / 1000);

function event(over: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "u@orrey",
    sequence: 0,
    startsAt: Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000),
    endsAt: Math.floor(Date.parse("2026-09-20T22:00:00Z") / 1000),
    summary: "Age of Umbra — Session 12",
    status: "CONFIRMED",
    ...over,
  };
}

function calendar(events: IcsEvent[], timeZone = "Europe/London") {
  return serialise({ name: "Orrey", timeZone, events, stampedAt: STAMP });
}

/** Every content line, unfolded, the way a client reads them. */
function unfold(text: string): string[] {
  return text
    .split("\r\n")
    .reduce<string[]>((lines, line) => {
      if (line.startsWith(" ") && lines.length > 0) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
      return lines;
    }, [])
    .filter((line) => line !== "");
}

beforeEach(async () => {
  for (const table of ["attendance", "campaign_members", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("line endings and folding", () => {
  it("ends every line with CRLF, the last one included", async () => {
    const text = calendar([event()]);

    expect(text.endsWith("\r\n")).toBe(true);
    // A lone LF anywhere is the failure: some clients take the file and drop
    // every event after the first one.
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("folds at 75 octets, not 75 characters", async () => {
    const line = `SUMMARY:${"a".repeat(200)}`;
    const folded = fold(line);

    for (const piece of folded) {
      expect(new TextEncoder().encode(piece).length).toBeLessThanOrEqual(75);
    }
    expect(folded.slice(1).every((piece) => piece.startsWith(" "))).toBe(true);
  });

  it("never splits a UTF-8 sequence across a fold", async () => {
    // Two octets each, so a character-counted fold lands mid-sequence — and what
    // the client shows then is a replacement character or nothing at all.
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = fold(line);

    const rejoined = folded.map((piece, i) => (i === 0 ? piece : piece.slice(1))).join("");
    expect(rejoined).toBe(line);
    expect(rejoined).not.toContain("�");
  });

  it("leaves a short line alone", async () => {
    expect(fold("VERSION:2.0")).toEqual(["VERSION:2.0"]);
  });

  it("unfolds back to what it folded", async () => {
    const long = "Age of Umbra, in the Deeps, with a rather long subtitle after it".repeat(3);
    const text = calendar([event({ summary: long })]);

    expect(unfold(text)).toContain(`SUMMARY:${escapeText(long)}`);
  });
});

describe("escaping", () => {
  it("escapes a comma, a semicolon and a newline", async () => {
    expect(escapeText("Blades, in the Dark; at night\nupstairs")).toBe(
      "Blades\\, in the Dark\\; at night\\nupstairs",
    );
  });

  it("escapes the backslash first, so it does not escape the escapes", async () => {
    expect(escapeText("a\\,b")).toBe("a\\\\\\,b");
  });

  it("round-trips a comma in a campaign name through the file", async () => {
    const text = calendar([event({ summary: "Blades, in the Dark" })]);

    // The ordinary case, not a contrived one — an unescaped comma makes the
    // client read one property as two.
    expect(unfold(text)).toContain("SUMMARY:Blades\\, in the Dark");
  });
});

describe("the zone", () => {
  it("declares the two offsets a session in July and one in January need", async () => {
    const july = event({
      startsAt: Math.floor(Date.parse("2026-07-15T18:00:00Z") / 1000),
      endsAt: Math.floor(Date.parse("2026-07-15T22:00:00Z") / 1000),
      uid: "july@orrey",
    });
    const january = event({
      startsAt: Math.floor(Date.parse("2026-01-15T18:00:00Z") / 1000),
      endsAt: Math.floor(Date.parse("2026-01-15T22:00:00Z") / 1000),
      uid: "january@orrey",
    });

    const lines = unfold(calendar([january, july]));

    expect(lines).toContain("TZOFFSETTO:+0100");
    expect(lines).toContain("TZOFFSETTO:+0000");
    // The wall clock, not UTC: 18:00 UTC in July is 19:00 in London and 18:00 in
    // January.
    expect(lines).toContain("DTSTART;TZID=Europe/London:20260715T190000");
    expect(lines).toContain("DTSTART;TZID=Europe/London:20260115T180000");
  });

  it("lists the transitions as RDATEs rather than an RRULE", async () => {
    const lines = vtimezone("Europe/London", [2026, 2027]);

    // A feed over a bounded window does not need a rule that extrapolates for
    // ever, and a list of instants is a thing this test can check exactly.
    expect(lines.join("\n")).not.toContain("RRULE");
    expect(lines.filter((line) => line.startsWith("RDATE:"))).toHaveLength(2);
  });

  it("finds the change at the second it happens", async () => {
    // The UK goes forward at 01:00 UTC on 29 March 2026.
    const before = Math.floor(Date.parse("2026-03-29T00:59:59Z") / 1000);
    const after = Math.floor(Date.parse("2026-03-29T01:00:00Z") / 1000);

    expect(offsetAt("Europe/London", before)).toBe("+0000");
    expect(offsetAt("Europe/London", after)).toBe("+0100");
  });

  it("still declares a zone that never changes", async () => {
    const lines = vtimezone("UTC", [2026]);

    // A DTSTART whose TZID names nothing is one a client reads as floating.
    expect(lines[1]).toBe("TZID:UTC");
    expect(lines.join("\n")).toContain("TZOFFSETTO:+0000");
  });

  it("renders midnight as 00 rather than 24", async () => {
    const midnight = Math.floor(Date.parse("2026-01-15T00:00:00Z") / 1000);
    expect(localStamp(midnight, "Europe/London")).toBe("20260115T000000");
  });
});

describe("the event", () => {
  it("carries the UID the Google event carries", async () => {
    await seed();
    const target = (await loadProjectionTarget(env, "age-of-umbra-s12"))!;

    const ics = await icsEventFor(target);

    // One identity across both projections, so a support question about either
    // can be answered from the other.
    expect(ics.uid).toBe(`${await eventIdFor("age-of-umbra-s12")}@orrey`);
  });

  it("emits a cancelled session rather than dropping it", async () => {
    const lines = unfold(calendar([event({ status: "CANCELLED" })]));

    // Dropping it leaves the event in every subscriber's calendar for ever,
    // which is the opposite of calling it off.
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines.filter((line) => line.startsWith("UID:"))).toHaveLength(1);
  });

  it("is tentative until somebody confirms it", async () => {
    await seed();
    expect((await icsEventFor((await loadProjectionTarget(env, "age-of-umbra-s12"))!)).status).toBe(
      "TENTATIVE",
    );

    await db(env)
      .update(schema.sessions)
      .set({ state: "CONFIRMED" })
      .where(eq(schema.sessions.id, "age-of-umbra-s12"));
    expect((await icsEventFor((await loadProjectionTarget(env, "age-of-umbra-s12"))!)).status).toBe(
      "CONFIRMED",
    );
  });
});

describe("SEQUENCE", () => {
  it("rises when the date moves", async () => {
    await seed();
    expect(await sequenceOf()).toBe(0);

    await moveSession(env, "age-of-umbra-s12", {
      startsAt: Math.floor(Date.parse("2026-09-27T18:00:00Z") / 1000),
      endsAt: Math.floor(Date.parse("2026-09-27T22:00:00Z") / 1000),
    });

    // Every subscribed calendar has to be told this update supersedes the one it
    // holds, and the number is what tells it.
    expect(await sequenceOf()).toBe(1);
  });

  it("does not rise when the roster changes", async () => {
    await seed();
    await db(env)
      .insert(schema.users)
      .values({ discordId: "a", username: "a", feedToken: "t-a" })
      .onConflictDoNothing();
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: "age-of-umbra-s12", userId: "a", intent: "in" });

    // SEQUENCE is about the event. A client re-prompting every attendee because
    // somebody clicked Maybe is a client nobody keeps subscribed.
    expect(await sequenceOf()).toBe(0);
  });

  it("is a counter and not updated_at", async () => {
    await seed();
    const row = await db(env)
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, "age-of-umbra-s12"))
      .get();

    // RFC 5545 caps SEQUENCE at a signed 32-bit integer, and unix seconds cross
    // that in 2038. A client that will not take the number stops taking updates.
    expect(row?.icsSequence).toBe(0);
    expect(row?.icsSequence).not.toBe(row?.updatedAt);
  });
});

function sequenceOf() {
  return db(env)
    .select({ n: schema.sessions.icsSequence })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, "age-of-umbra-s12"))
    .get()
    .then((row) => row?.n);
}

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.sessions)
    .values({
      id: "age-of-umbra-s12",
      kind: "campaign_session",
      campaignId: "age-of-umbra",
      number: 12,
      startsAt: Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000),
      endsAt: Math.floor(Date.parse("2026-09-20T22:00:00Z") / 1000),
      location: "The Wreck",
    });
}
