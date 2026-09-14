import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import { quorumLine, quorumOf } from "./quorum.ts";

/**
 * The attendance post, rendered from D1 and nothing else.
 *
 * A post is a snapshot. Orrey never edits one from the outside — the only write
 * is a click rewriting the message it came from — so the post carries an as-of
 * line and a Refresh button, and that is the whole story of how a stale reading
 * becomes current.
 *
 * This function is pure on purpose: the clock arrives as an argument, so what a
 * click renders is exactly what a test can render.
 */
export interface AttendanceRow {
  userId: string;
  /** Display name at the time they clicked; `users` holds it as a cache. */
  name: string;
  intent: "in" | "out" | "maybe" | null;
  note: string | null;
}

export interface AttendanceView {
  target: ProjectionTarget;
  rows: AttendanceRow[];
  asOf: Date;
}

export interface MessagePayload {
  content: string;
  components: Record<string, unknown>[];
  allowed_mentions: { parse: never[]; roles: string[] };
}

export function renderAttendancePost({ target, rows, asOf }: AttendanceView): MessagePayload {
  const { session, campaign } = target;

  // Three passes, because a post over Discord's 2000 characters is not a post
  // that reads badly — it is a post whose every later click is rejected, and
  // under send-only there is no shortening it afterwards. Notes go first, then
  // the names themselves, leaving the counts that actually answer the question.
  let content = compose(target, rows, asOf, { notes: true, names: true });
  if (content.length > LIMIT) content = compose(target, rows, asOf, { notes: false, names: true });
  if (content.length > LIMIT) content = compose(target, rows, asOf, { notes: false, names: false });

  return {
    content,
    components: [buttons(session.id)],
    // The roster is the audience, and only the roster: a mention Orrey did not
    // mean — @everyone, or a user id that wandered in from a note — cannot fire.
    allowed_mentions: { parse: [], roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [] },
  };
}

/** Discord's ceiling is 2000; the slack absorbs the characters escaping adds. */
const LIMIT = 1900;

/** How much of each row survives this pass. */
interface Detail {
  notes: boolean;
  names: boolean;
}

function compose(
  target: ProjectionTarget,
  rows: AttendanceRow[],
  asOf: Date,
  detail: Detail,
): string {
  const { session } = target;
  const lines = [heading(target), when(session.startsAt, session.endsAt)];

  if (session.location) lines.push(escapeMarkdown(session.location));
  lines.push("");

  for (const [intent, label] of [
    ["in", "In"],
    ["out", "Out"],
    ["maybe", "Maybe"],
  ] as const) {
    const named = rows.filter((row) => row.intent === intent);
    if (named.length === 0) continue;
    const who = detail.names ? ` — ${named.map((row) => name(row, detail)).join(", ")}` : "";
    lines.push(`**${label} (${named.length})**${who}`);
  }

  // A note without an answer is still something the others should see.
  const unanswered = rows.filter((row) => row.intent === null && row.note);
  const showNotes = detail.notes && detail.names && unanswered.length > 0;
  if (showNotes) {
    lines.push(`**Notes** — ${unanswered.map((row) => name(row, detail)).join(", ")}`);
  }

  // The people on the roster who have not answered. This is the half of the
  // question "four in" cannot answer on its own, and it is deliberately not a
  // tally of "out": silence is silence. Anyone whose note is already above is
  // not repeated here — they have been heard from, just not answered.
  // Anyone with no intent who is not already named in the Notes line *of this
  // pass*. The truncation passes drop Notes, and somebody who left a note but no
  // answer would then appear nowhere at all — which also made the count smaller
  // than the roster and turned a shortened post into a quietly wrong one.
  const silent = rows.filter((row) => row.intent === null && !(showNotes && row.note));
  if (silent.length > 0) {
    const who = detail.names ? ` — ${silent.map((row) => name(row, detail)).join(", ")}` : "";
    lines.push(`**Not heard from (${silent.length})**${who}`);
  }

  if (rows.length === 0) lines.push("*Nobody has said yet.*");

  // Does it run. Last, because it is the answer and the tallies above are the
  // working — and it survives every truncation pass, because a post shortened
  // past the one line that answers the question is a post worth nothing.
  const quorum = quorumLine(quorumOf(target, rows));
  if (quorum) lines.push("", quorum);

  lines.push("", `-# As of <t:${unix(asOf)}:R>. Refresh for a fresh reading.`);
  return lines.join("\n");
}

/** The five buttons, in one row — Discord allows five, which is exactly enough. */
export function buttons(sessionId: string): Record<string, unknown> {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      button("In", sessionId, "in", ButtonStyle.SUCCESS),
      button("Out", sessionId, "out", ButtonStyle.DANGER),
      button("Maybe", sessionId, "maybe", ButtonStyle.SECONDARY),
      button("Note", sessionId, "note", ButtonStyle.SECONDARY),
      button("Refresh", sessionId, "refresh", ButtonStyle.SECONDARY),
    ],
  };
}

function button(label: string, sessionId: string, arg: string, style: number) {
  return {
    type: ComponentType.BUTTON,
    style,
    label,
    custom_id: encodeCustomId({ action: "attend", arg, target: sessionId }),
  };
}

function heading(target: ProjectionTarget): string {
  const role = target.campaign?.discordRoleId;
  const title = escapeMarkdown(sessionTitle(target));
  return role ? `<@&${role}> **${title}**` : `**${title}**`;
}

/**
 * Discord renders `<t:…>` in each reader's own timezone, which is the only way
 * a single posted string is correct for everyone reading it.
 */
function when(startsAt: number, endsAt: number): string {
  return `<t:${startsAt}:F> → <t:${endsAt}:t>`;
}

function name(row: AttendanceRow, detail: Detail): string {
  const who = escapeMarkdown(row.name);
  return detail.notes && row.note ? `${who} (${escapeMarkdown(row.note)})` : who;
}

/**
 * A note is somebody else's text on a post Orrey can never edit. Unescaped, a
 * note reading `**Out (4)** — Bob, Cara` renders as a heading of Orrey's own
 * shape, and a stray backtick reflows everything after it — the as-of line
 * included. So the markdown a note can use is the markdown it escapes.
 *
 * Only the inline set: a note is normalised to one line and never rendered at
 * the start of one, so `#` and `>` cannot open a block.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\])/g, "\\$1");
}

function unix(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
