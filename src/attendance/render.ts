import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";

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
  const lines = [heading(target), when(session.startsAt, session.endsAt)];

  if (session.location) lines.push(session.location);
  lines.push("");

  for (const [intent, label] of [
    ["in", "In"],
    ["out", "Out"],
    ["maybe", "Maybe"],
  ] as const) {
    const named = rows.filter((row) => row.intent === intent);
    if (named.length > 0) lines.push(`**${label} (${named.length})** — ${named.map(name).join(", ")}`);
  }
  // A note without an answer is still something the others should see.
  const unanswered = rows.filter((row) => row.intent === null && row.note);
  if (unanswered.length > 0) lines.push(`**Notes** — ${unanswered.map(name).join(", ")}`);

  if (rows.every((row) => row.intent === null) && unanswered.length === 0) {
    lines.push("*Nobody has said yet.*");
  }

  lines.push("", `-# As of <t:${unix(asOf)}:R>. Refresh for a fresh reading.`);

  return {
    content: lines.join("\n"),
    components: [buttons(session.id)],
    // The roster is the audience, and only the roster: a mention Orrey did not
    // mean — @everyone, or a user id that wandered in from a note — cannot fire.
    allowed_mentions: { parse: [], roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [] },
  };
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
  return role ? `<@&${role}> **${sessionTitle(target)}**` : `**${sessionTitle(target)}**`;
}

/**
 * Discord renders `<t:…>` in each reader's own timezone, which is the only way
 * a single posted string is correct for everyone reading it.
 */
function when(startsAt: number, endsAt: number): string {
  return `<t:${startsAt}:F> → <t:${endsAt}:t>`;
}

function name(row: AttendanceRow): string {
  return row.note ? `${row.name} (${row.note})` : row.name;
}

function unix(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
