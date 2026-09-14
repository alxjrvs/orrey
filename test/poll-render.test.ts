import { describe, expect, it } from "vitest";
import { decodeCustomId } from "../src/discord/custom-id.ts";
import { ComponentType } from "../src/discord/types.ts";
import { MAX_DATES, renderPollPost, type PollView } from "../src/polls/render.ts";

/**
 * The post as a pure function of rows. Nothing here touches D1, Discord or the
 * clock — the clock is an argument, which is the whole reason a renderer is its
 * own slice.
 */
const ASOF = new Date("2026-09-14T12:00:00Z");
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;
const DAY = 86_400;

function view(over: Partial<PollView> = {}): PollView {
  return {
    poll: { id: "pollid123456", title: null, status: "open", closesAt: null },
    dates: [
      { id: "d1", startsAt: START, endsAt: START + 14_400, yes: 2, outcome: "open" },
      { id: "d2", startsAt: START + DAY, endsAt: START + DAY + 14_400, yes: 4, outcome: "open" },
    ],
    rosterSize: 5,
    asOf: ASOF,
    ...over,
  };
}

function rows(payload: { components: Record<string, unknown>[] }) {
  return payload.components.map(
    (row) => (row as { components: Record<string, unknown>[] }).components,
  );
}

describe("the body", () => {
  it("renders every date in the reader's own zone", () => {
    const { content } = renderPollPost(view());

    // For a question that is entirely about *when*, getting the time wrong for
    // half the table is getting the whole post wrong.
    expect(content).toContain(`<t:${START}:F>`);
    expect(content).toContain(`<t:${START + DAY}:F>`);
    expect(content).toContain("2 of 5");
    expect(content).toContain("4 of 5");
  });

  it("carries its own as-of, and says the answer replaces the last one", () => {
    const { content } = renderPollPost(view());
    expect(content).toContain(`<t:${Math.floor(ASOF.getTime() / 1000)}:t>`);
    expect(content).toContain("replaces your last one");
  });

  it("escapes a title somebody else wrote", () => {
    const { content } = renderPollPost(
      view({
        poll: { id: "p", title: "**Out (4)** — `everyone`", status: "open", closesAt: null },
      }),
    );

    // A title is somebody else's text on a post Orrey can never edit. Unescaped,
    // it renders as a heading of Orrey's own shape.
    expect(content).toContain("\\*\\*Out (4)\\*\\*");
    expect(content).toContain("\\`everyone\\`");
  });

  it("names nobody at all", () => {
    const payload = renderPollPost(view());
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it("says when answering stops", () => {
    const { content } = renderPollPost(
      view({ poll: { id: "p", title: null, status: "open", closesAt: START - DAY } }),
    );
    expect(content).toContain(`<t:${START - DAY}:R>`);
  });
});

describe("the components", () => {
  it("puts the select alone in the first row and the buttons in the second", () => {
    const [first, second] = rows(renderPollPost(view()));

    expect(first).toHaveLength(1);
    expect(first?.[0]).toMatchObject({ type: ComponentType.STRING_SELECT });
    expect(second?.map((c) => (c as { label: string }).label)).toEqual(["Refresh", "Canonise"]);
  });

  it("lets somebody answer with nothing", () => {
    const [[select]] = rows(renderPollPost(view())) as [[{ min_values: number }]];

    // "None of these work" is a real answer, and a select that cannot be emptied
    // cannot say it.
    expect(select.min_values).toBe(0);
  });

  it("lets somebody pick every date there is", () => {
    const dates = Array.from({ length: MAX_DATES }, (_, i) => ({
      id: `d${i}`,
      startsAt: START + i * DAY,
      endsAt: START + i * DAY + 14_400,
      yes: i,
      outcome: "open" as const,
    }));

    const [[select]] = rows(renderPollPost(view({ dates }))) as [
      [{ max_values: number; options: unknown[] }],
    ];
    expect(select.options).toHaveLength(MAX_DATES);
    expect(select.max_values).toBe(MAX_DATES);
  });

  it("comes back prefilled with what this person already chose", () => {
    const [[select]] = rows(renderPollPost(view({ chosen: ["d2"] }))) as [
      [{ options: { value: string; default: boolean }[] }],
    ];

    expect(select.options.find((o) => o.value === "d2")?.default).toBe(true);
    expect(select.options.find((o) => o.value === "d1")?.default).toBe(false);
  });

  it("mints every id through custom-id, well inside the ceiling", () => {
    const ids = rows(renderPollPost(view()))
      .flat()
      .map((c) => (c as { custom_id: string }).custom_id);

    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id.length).toBeLessThan(100);
      expect(decodeCustomId(id)).toMatchObject({ action: "poll", target: "pollid123456" });
    }
    expect(ids.map((id) => decodeCustomId(id)?.arg)).toEqual(["select", "refresh", "canon"]);
  });
});

describe("a closed poll", () => {
  it("has nothing left to click", () => {
    const payload = renderPollPost(
      view({ poll: { id: "p", title: null, status: "closed", closesAt: null } }),
    );

    expect(payload.components).toEqual([]);
    expect(payload.content).toContain("Closed");
  });

  it("marks what won and what did not", () => {
    const { content } = renderPollPost(
      view({
        poll: { id: "p", title: null, status: "closed", closesAt: null },
        dates: [
          { id: "d1", startsAt: START, endsAt: START + 1, yes: 2, outcome: "lost" },
          { id: "d2", startsAt: START + DAY, endsAt: START + DAY + 1, yes: 4, outcome: "won" },
        ],
      }),
    );

    expect(content).toContain(`**✓** <t:${START + DAY}:F>`);
    expect(content).toContain(`-# <t:${START}:F>`);
  });
});

describe("what it does not do", () => {
  it("is pure — same rows, same clock, same bytes", () => {
    expect(JSON.stringify(renderPollPost(view()))).toBe(JSON.stringify(renderPollPost(view())));
  });

  it("says nothing about a roster it was not told the size of", () => {
    const { content } = renderPollPost(view({ rosterSize: null }));

    // The assertion has to be the shape of the tally rather than any two words
    // that look like one — prose contains " of " all the time.
    expect(content).not.toMatch(/— \d+ of \d+/);
    expect(content).toMatch(/— 2\n/);
  });
});
