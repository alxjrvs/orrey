import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { fingerprint } from "../src/projection/fingerprint.ts";
import { googleProjectedContent } from "../src/projection/target.ts";
import {
  classifyEvent,
  sessionIdOf,
  shapeOf,
  type LinkRow,
  type SessionShape,
} from "../src/google/classify.ts";
import { classifyAll } from "../src/google/sync.ts";
import type { CalendarEvent } from "../src/google/sync.ts";

/**
 * Orrey's own handwriting.
 *
 * An echo that stops being recognised is an infinite loop; a change misread as
 * an echo is a drag in Google that Orrey silently reverts. So the two properties
 * this file pins are that the verdict comes from a *recomputed* fingerprint,
 * and that the shape it recomputes is the same one the projector hashed.
 */
const START = Math.floor(Date.parse("2026-09-20T19:00:00Z") / 1000);

const session: SessionShape = {
  id: "umbra-s12",
  startsAt: START,
  endsAt: START + 4 * 3600,
  location: "The Wreck",
  state: "SCHEDULED",
};

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Age of Umbra — Session 12",
    location: "The Wreck",
    start: { dateTime: new Date(START * 1000).toISOString() },
    end: { dateTime: new Date((START + 4 * 3600) * 1000).toISOString() },
    extendedProperties: { private: { orreySessionId: session.id } },
    ...over,
  };
}

/** The fingerprint the projector would have stored for the untouched event. */
async function stored(over: Partial<CalendarEvent> = {}): Promise<LinkRow> {
  return {
    sessionId: session.id,
    gcalEventId: "evt-1",
    fingerprint: await fingerprint(shapeOf(event(over), session)),
  };
}

describe("the shape it rebuilds", () => {
  it("is the one the projector hashed, field for field", async () => {
    // Compared against `googleProjectedContent` itself rather than a literal:
    // these two must not drift, because the fingerprint the projector stored
    // was computed from that function. If this built a different shape, nothing
    // would ever match and every pass would call everything changed — the
    // infinite loop, arrived at from the other side.
    const projected = googleProjectedContent({
      session: {
        id: session.id,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        location: session.location,
        state: session.state,
        campaignId: "umbra",
        number: 12,
      },
      campaign: { name: "Age of Umbra", locationType: "external" },
      gameDay: null,
      game: null,
    } as never);

    expect(Object.keys(shapeOf(event(), session)).sort()).toEqual(Object.keys(projected).sort());
  });

  it("takes state from the session, never from the event", () => {
    // State does not exist in Google at all, so an event has no way to disagree
    // about it — which is exactly #48's rule that Google never cancels a
    // session, expressed as a thing that cannot be said rather than a check.
    const shape = shapeOf(
      event({ summary: "CANCELLED — do not come" }),
      { ...session, state: "CONFIRMED" },
    );

    expect(shape.state).toBe("CONFIRMED");
  });
});

describe("the verdict", () => {
  it("is echo for an event matching the stored fingerprint", async () => {
    expect(await classifyEvent(event(), await stored(), session)).toBe("echo");
  });

  it("is changed when the start moved", async () => {
    const moved = event({ start: { dateTime: new Date((START + 3600) * 1000).toISOString() } });

    expect(await classifyEvent(moved, await stored(), session)).toBe("changed");
  });

  it("is changed when the summary was retyped", async () => {
    expect(
      await classifyEvent(event({ summary: "Umbra (moved to Ada's)" }), await stored(), session),
    ).toBe("changed");
  });

  it("is changed when the location was retyped", async () => {
    expect(
      await classifyEvent(event({ location: "The other place" }), await stored(), session),
    ).toBe("changed");
  });

  it("is deleted for a cancelled event", async () => {
    expect(await classifyEvent(event({ status: "cancelled" }), await stored(), session)).toBe(
      "deleted",
    );
  });

  it("is foreign for an event with nothing of Orrey's behind it", async () => {
    expect(await classifyEvent(event(), undefined, undefined)).toBe("foreign");
  });
});

describe("what it must not read", () => {
  it("ignores the orreyFingerprint property entirely", async () => {
    const link = await stored();

    // A human dragging an event leaves this property untouched. Trusting it
    // would call every real change an echo — the exact failure the phase exists
    // to prevent, reached by the more convenient route.
    const lying = event({
      summary: "Retyped by somebody",
      extendedProperties: {
        private: { orreySessionId: session.id, orreyFingerprint: link.fingerprint as string },
      },
    });

    expect(await classifyEvent(lying, link, session)).toBe("changed");
  });

  it("gives the same verdict whether that property is stale, absent or right", async () => {
    const link = await stored();
    const verdicts = await Promise.all(
      [
        { orreySessionId: session.id },
        { orreySessionId: session.id, orreyFingerprint: "stale" },
        { orreySessionId: session.id, orreyFingerprint: link.fingerprint as string },
      ].map((priv) => classifyEvent(event({ extendedProperties: { private: priv } }), link, session)),
    );

    expect(verdicts).toEqual(["echo", "echo", "echo"]);
  });

  it("gives the same verdict when every attendee has declined", async () => {
    // `responseStatus` is not an RSVP and never will be.
    const declined = event({
      ...({ attendees: [{ email: "a@example.com", responseStatus: "declined" }] } as object),
    });

    expect(await classifyEvent(declined, await stored(), session)).toBe("echo");
  });
});

describe("finding the session", () => {
  const links: LinkRow[] = [
    { sessionId: "umbra-s12", gcalEventId: "evt-1", fingerprint: "abc" },
  ];

  it("reads the property Orrey writes", () => {
    expect(sessionIdOf(event(), [])).toBe("umbra-s12");
  });

  it("falls back to the link for an event whose properties were stripped", () => {
    const stripped = { ...event() };
    delete (stripped as { extendedProperties?: unknown }).extendedProperties;

    expect(sessionIdOf(stripped, links)).toBe("umbra-s12");
  });

  it("finds nothing for somebody else's event", () => {
    expect(sessionIdOf({ id: "their-lunch", summary: "Lunch" }, links)).toBeUndefined();
  });
});

describe("classifying a whole list", () => {
  beforeEach(async () => {
    for (const table of ["calendar_links", "sessions", "campaigns", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: session.id,
        kind: "campaign_session",
        campaignId: "umbra",
        number: 12,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        ...(session.location === null ? {} : { location: session.location }),
        state: session.state as "SCHEDULED",
      });
  });

  it("leaves somebody else's event alone", async () => {
    const [only] = await classifyAll(env, [{ id: "their-lunch", summary: "Lunch" }]);

    expect(only).toMatchObject({ verdict: "foreign", sessionId: undefined });
  });

  it("recognises Orrey's own write as an echo", async () => {
    const link = await stored();
    await db(env)
      .insert(schema.calendarLinks)
      .values({
        sessionId: link.sessionId,
        gcalEventId: link.gcalEventId,
        fingerprint: link.fingerprint,
      });

    const [only] = await classifyAll(env, [event()]);

    expect(only).toMatchObject({ verdict: "echo", sessionId: session.id });
  });

  it("calls a dragged event changed", async () => {
    const link = await stored();
    await db(env)
      .insert(schema.calendarLinks)
      .values({
        sessionId: link.sessionId,
        gcalEventId: link.gcalEventId,
        fingerprint: link.fingerprint,
      });

    const [only] = await classifyAll(env, [
      event({ start: { dateTime: new Date((START + 7200) * 1000).toISOString() } }),
    ]);

    expect(only?.verdict).toBe("changed");
  });

  it("writes nothing to sessions", async () => {
    const before = await db(env).select().from(schema.sessions).all();

    await classifyAll(env, [event({ summary: "Retyped" })]);

    expect(await db(env).select().from(schema.sessions).all()).toEqual(before);
  });
});
