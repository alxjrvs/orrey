import { encodeCustomId } from "../discord/custom-id.ts";
import { escapeMarkdown } from "../discord/markdown.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import { gameDayTitle } from "../projection/target.ts";
import type { MessagePayload } from "../attendance/render.ts";
import type { schema } from "../db/index.ts";
import type { DaySignup } from "./signups.ts";

/**
 * The signup post, rendered from D1 and nothing else.
 *
 * Built the way the attendance post was, and for the same reasons: pure, with
 * the clock arriving as an argument so what a click renders is exactly what a
 * test renders; a snapshot with an as-of line and a Refresh button, because
 * Orrey never edits a post from the outside and the only rewrite is a click
 * rewriting the message it came from.
 *
 * The audience is different, though, and it changes one thing. An attendance
 * post is addressed to a campaign's roster and mentions its role; a game day is
 * open to the whole server, so there is nobody in particular to mention and
 * `allowed_mentions` names nothing at all.
 */
export interface SignupView {
  day: typeof schema.gameDays.$inferSelect;
  /** What a `single` day is playing. Null for a `multi` day, and for a lost game. */
  game: typeof schema.games.$inferSelect | null;
  /** Live claims only, in arrival order — `signupsForDay` leaves out withdrawals. */
  signups: DaySignup[];
  /** Seats, or null for "however many turn up". */
  capacity: number | null;
  asOf: Date;
}

/** Discord's ceiling is 2000; the slack absorbs the characters escaping adds. */
const LIMIT = 1900;

export function renderSignupPost(view: SignupView): MessagePayload {
  // Three passes, the same ladder the attendance post climbs down. Character
  // names first, then the names themselves, leaving the counts that answer the
  // question — because a post over 2000 characters is not one that reads badly,
  // it is one whose every later click is rejected, and under send-only there is
  // no shortening it afterwards.
  let content = compose(view, { characters: true, names: true });
  if (content.length > LIMIT) content = compose(view, { characters: false, names: true });
  if (content.length > LIMIT) content = compose(view, { characters: false, names: false });

  return {
    content,
    components: [seatButtons(view.day.id, view.day.kind, view.capacity)],
    // Nothing. A game day has no role of its own and its post is addressed to
    // the room, so there is no mention Orrey means to fire — and `parse: []`
    // turns off the ones it does not.
    allowed_mentions: { parse: [], roles: [] },
  };
}

/** How much of each row survives this pass. */
interface Detail {
  characters: boolean;
  names: boolean;
}

function compose({ day, game, signups, capacity, asOf }: SignupView, detail: Detail): string {
  const lines = [`**${escapeMarkdown(gameDayTitle(day, game))}**`, when(day.startsAt, day.endsAt)];

  if (day.venue) lines.push(escapeMarkdown(day.venue));
  lines.push("");

  const seated = signups.filter((signup) => signup.state === "in");
  const queued = signups.filter((signup) => signup.state === "waitlisted");

  // A `single` day is a table: the question is whether there is a seat, and the
  // count is the answer. A `multi` day is a hangout, and the question is whether
  // you are coming — so the heading says so, and there is no seat count unless
  // somebody set a capacity, because inventing one would be answering a question
  // the day has not asked.
  const multi = day.kind === "multi";
  const of = capacity === null ? `${seated.length}` : `${seated.length}/${capacity}`;
  lines.push(`**${multi ? "Coming" : "Seated"} (${of})**${named(seated, detail)}`);
  if (queued.length > 0) lines.push(`**Waitlist (${queued.length})**${named(queued, detail)}`);

  if (signups.length === 0) {
    lines.push(multi ? "*Nobody has said yet.*" : "*Nobody has taken a seat yet.*");
  }

  // The answer, last, because everything above it is the working — and it
  // survives every truncation pass, because a post shortened past the one line
  // that says whether there is room is a post worth nothing.
  lines.push("", room(capacity, seated.length, multi));

  lines.push("", `-# As of <t:${unix(asOf)}:R>. Refresh for a fresh reading.`);
  return lines.join("\n");
}

/**
 * Whether there is room, in the words somebody deciding would use.
 *
 * A day with no capacity says so rather than inventing one: "however many turn
 * up" is a real answer and a made-up number is not.
 */
function room(capacity: number | null, seated: number, multi: boolean): string {
  if (capacity === null) {
    return multi ? "*Everybody welcome — just say you're coming.*" : "*Room for however many turn up.*";
  }
  const left = Math.max(0, capacity - seated);
  if (left === 0) {
    return multi
      ? "*Full. Coming puts you on the waitlist.*"
      : "*Full. Take a seat puts you on the waitlist.*";
  }
  const noun = left === 1 ? "place" : "places";
  if (multi) return `*${left} ${noun} left.*`;
  return left === 1 ? "*One seat left.*" : `*${left} seats left.*`;
}

function named(signups: DaySignup[], detail: Detail): string {
  if (!detail.names || signups.length === 0) return "";
  return ` — ${signups.map((signup) => name(signup, detail)).join(", ")}`;
}

function name(signup: DaySignup, detail: Detail): string {
  const who = escapeMarkdown(signup.name);
  if (!detail.characters || !signup.characterName) return who;
  return `${who} (${escapeMarkdown(signup.characterName)})`;
}

/**
 * One row, and the same three or four ids under two sets of words.
 *
 * **Take a seat** and **Coming** are the same click: `claimSeat`, preferring a
 * seat. They are not two arguments, because they are not two things — a `multi`
 * day is asking whether you are coming to the day rather than whether you want
 * one of five chairs, and the word that fits is the only difference. A second
 * `custom_id` argument meaning exactly what the first one means is a second
 * handler branch to keep in step for nothing.
 *
 * **Waitlist** is absent on a day with no capacity. There is no queue to join
 * when there is no limit to be past, and a button that always lands somebody in
 * a waitlist of one is a button that lies about what the day is.
 *
 * **Take a seat** and **Waitlist** land in the same place on a full day — the
 * first is what somebody clicks when they have not looked at the count, and
 * being told which they got by the post they get back is kinder than refusing
 * the click.
 *
 * The attendance post's fifth button, *Suggest another day*, is deliberately not
 * here: it opens a poll targeted at a *session*, a day in SEATING has no session
 * until `p5/9` mints one, and the untargeted poll that would be the alternative
 * is the thing that produced this day in the first place. A button that loops
 * back to where you came from is worse than no button.
 */
export function seatButtons(
  gameDayId: string,
  kind: "single" | "multi" = "single",
  capacity: number | null = null,
): Record<string, unknown> {
  const yes = kind === "multi" ? "Coming" : "Take a seat";

  return {
    type: ComponentType.ACTION_ROW,
    components: [
      button(yes, gameDayId, "in", ButtonStyle.SUCCESS),
      ...(capacity === null ? [] : [button("Waitlist", gameDayId, "wait", ButtonStyle.SECONDARY)]),
      button("Out", gameDayId, "out", ButtonStyle.DANGER),
      button("Refresh", gameDayId, "refresh", ButtonStyle.SECONDARY),
    ],
  };
}

function button(label: string, gameDayId: string, arg: string, style: number) {
  return {
    type: ComponentType.BUTTON,
    style,
    label,
    custom_id: encodeCustomId({ action: "seat", arg, target: gameDayId }),
  };
}

/**
 * `<t:…:F>` twice rather than a rendered date: Discord renders both in the
 * reader's own zone, which is the only way one line is right for everybody.
 */
function when(startsAt: number, endsAt: number): string {
  return `<t:${startsAt}:F> — <t:${endsAt}:t>`;
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
