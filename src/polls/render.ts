import { escapeMarkdown } from "../discord/markdown.ts";
import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import type { MessagePayload } from "../attendance/render.ts";

/**
 * The poll post, as a pure function of rows.
 *
 * The same shape `src/attendance/render.ts` proved: the clock arrives as an
 * argument, nothing is fetched, nothing is read back out of a message. What a
 * click renders is exactly what a test can render.
 *
 * **The answer is a select rather than buttons**, and that is a Discord
 * constraint doing the designing: five buttons to a row and five rows means
 * twenty-five, but a poll with ten dates and a yes/no for each is twenty buttons
 * before Refresh, and the post becomes a wall. One `STRING_SELECT` with one
 * option per date says the same thing in one component, and Discord sends back
 * the *complete* selection every time — which is why the write one slice up is a
 * replacement rather than a toggle.
 *
 * `min_values: 0` is load-bearing: an empty selection is a real answer, "none of
 * these work", and a select that cannot be emptied cannot say it.
 */
export const MAX_DATES = 10;

export interface PollDateRow {
  id: string;
  startsAt: number;
  endsAt: number;
  /** How many people have said this one works. */
  yes: number;
  outcome: "open" | "won" | "lost" | "withdrawn";
}

export interface PollView {
  poll: {
    id: string;
    title: string | null;
    status: "open" | "closed";
    closesAt: number | null;
  };
  dates: PollDateRow[];
  /** How many could answer, so "4 yes" can be read against something. */
  rosterSize: number | null;
  /** What this person has already chosen, so the select comes back prefilled. */
  chosen?: string[];
  asOf: Date;
}

export function renderPollPost(view: PollView): MessagePayload {
  const { poll, dates, asOf } = view;

  const lines = [`**Which days work?**${poll.title ? ` ${escapeMarkdown(poll.title)}` : ""}`];

  if (poll.status === "closed") {
    lines.push("-# Closed. The dates below are what it decided.");
  } else if (poll.closesAt) {
    lines.push(`-# Answers close <t:${poll.closesAt}:R>.`);
  }

  lines.push("");
  for (const date of dates) lines.push(tally(date, view.rosterSize));
  lines.push("", `-# As of <t:${unix(asOf)}:t>. Your answer replaces your last one.`);

  return {
    content: lines.join("\n"),
    components: poll.status === "closed" ? [] : components(view),
    // A poll post names nobody. It goes to a channel people are already in, and
    // one that pings the roster every time somebody re-renders it is one people
    // mute.
    allowed_mentions: { parse: [], roles: [] },
  };
}

/**
 * One line per date. `<t:…:F>` renders in each reader's own zone, which is the
 * only way one posted string is right for everybody — and for a question that is
 * entirely about *when*, getting that wrong for half the table is getting the
 * whole post wrong.
 */
function tally(date: PollDateRow, rosterSize: number | null): string {
  const of = rosterSize === null ? "" : ` of ${rosterSize}`;
  const mark = date.outcome === "won" ? "**✓** " : date.outcome === "lost" ? "-# " : "";
  return `${mark}<t:${date.startsAt}:F> — ${date.yes}${of}`;
}

function components(view: PollView): Record<string, unknown>[] {
  const { poll, dates } = view;

  const select = {
    type: ComponentType.STRING_SELECT,
    custom_id: encodeCustomId({ action: "poll", arg: "select", target: poll.id }),
    placeholder: "Which of these work for you?",
    // Zero is an answer. See MAX_DATES above.
    min_values: 0,
    max_values: Math.max(1, Math.min(dates.length, MAX_DATES)),
    /**
     * **No `default`.** It is tempting — "the select comes back prefilled with
     * what this person already said" — and it is wrong on this message, because
     * this message is not this person's.
     *
     * A click answers with UPDATE_MESSAGE, which rewrites the one shared post
     * everybody in the channel is looking at. A `default` computed from the
     * clicker's own rows would be written into that shared post and stay there:
     * the next person to open the select would find somebody else's answer
     * ticked, and clicking Refresh would stamp their own over it. There is no
     * per-viewer rendering of a channel message to hang a prefill on.
     *
     * Each person's answer is in D1, and the tallies above are where it shows.
     * `renderOverride`'s `default` stays as it is — that one renders staged
     * poll-level state, which is the same for every viewer.
     */
    options: dates.slice(0, MAX_DATES).map((date) => ({
      label: label(date),
      value: date.id,
    })),
  };

  return [
    { type: ComponentType.ACTION_ROW, components: [select] },
    {
      type: ComponentType.ACTION_ROW,
      components: [
        button("Refresh", encodeCustomId({ action: "poll", arg: "refresh", target: poll.id })),
        button(
          "Canonise",
          encodeCustomId({ action: "poll", arg: "canon", target: poll.id }),
          ButtonStyle.PRIMARY,
        ),
      ],
    },
  ];
}

/**
 * A select option's label is plain text — Discord renders no markdown and no
 * `<t:…>` inside one — so this is the one place in the post that has to name a
 * wall-clock time. It says UTC rather than pretending, and the line above it in
 * the body carries the reader's own zone.
 */
function label(date: PollDateRow): string {
  const when = new Date(date.startsAt * 1000).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${when} UTC`.slice(0, 100);
}

function button(
  label: string,
  customId: string,
  style: number = ButtonStyle.SECONDARY,
): Record<string, unknown> {
  return { type: ComponentType.BUTTON, style, label, custom_id: customId };
}

function unix(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
