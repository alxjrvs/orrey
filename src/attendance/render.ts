import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import { escapeMarkdown } from "../discord/markdown.ts";

export { escapeMarkdown };
import { suggestRow } from "../polls/buttons.ts";
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
  /**
   * `parse: []` is the important half: it turns off @everyone, @here and every
   * role mention Orrey did not name on purpose. `roles` and `users` are then the
   * exhaustive list of what may actually fire.
   */
  allowed_mentions: { parse: never[]; roles: string[]; users?: string[] };
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
    components: [buttons(session.id), suggestRow(session.id)],
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

function unix(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/**
 * The confirmed notice. Short on purpose: the attendance post above it in the
 * thread carries the detail, and this exists to put the answer in front of
 * people who are not looking at a post they have already read.
 *
 * It carries no buttons. Every button in this repo sits on the thing it
 * concerns, and the thing this concerns is the attendance post.
 */
export function confirmedNotice(target: ProjectionTarget): MessagePayload {
  const { session, campaign } = target;
  return {
    content: [
      `**It's on.** ${escapeMarkdown(sessionTitle(target))}`,
      `<t:${session.startsAt}:F>${session.location ? ` — ${escapeMarkdown(session.location)}` : ""}`,
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [] },
  };
}


/**
 * The jeopardy notice. A new message in the thread, with its own as-of line,
 * posted when the clock found the session short a day out.
 *
 * It names who has not answered, because "we are two short" is a fact nobody can
 * act on and "we are two short and it is these three who have not said" is a
 * fact three people can. It mentions the roster role so the people who can fix it
 * see it, and it names the GM because the decision is theirs.
 *
 * Phase 4 gives it a *Suggest another day* button. Until then it says who to
 * talk to, which is the honest version of the same thing.
 */
export function jeopardyNotice({
  target,
  rows,
  gmId,
  required,
  asOf,
}: {
  target: ProjectionTarget;
  rows: AttendanceRow[];
  gmId: string | undefined;
  required: number;
  asOf: Date;
}): MessagePayload {
  const { session, campaign } = target;
  const saidIn = rows.filter((row) => row.intent === "in").length;
  const silent = rows.filter((row) => row.intent === null);

  const lines = [
    `**Is this one happening?** ${escapeMarkdown(sessionTitle(target))}`,
    `<t:${session.startsAt}:F> — ${saidIn} of ${required} in.`,
  ];

  if (silent.length > 0) {
    lines.push(
      "",
      `Not heard from: ${silent.map((row) => `<@${row.userId}>`).join(", ")}`,
    );
  }

  lines.push(
    "",
    gmId
      ? `<@${gmId}> decides whether it runs. Answering on the post above is what changes it.`
      : "Whoever is running it decides. Answering on the post above is what changes it.",
    `-# As of <t:${Math.floor(asOf.getTime() / 1000)}:R>.`,
  );

  return {
    content: lines.join("\n"),
    // The same mint the attendance post uses. Phase 3 said this notice would
    // gain the button "until then it says who to talk to"; this is then.
    components: [suggestRow(session.id)],
    // The roster, and the people named. Nothing else — a notice that could fire
    // @everyone because somebody's display name looked like one is a notice
    // nobody trusts.
    allowed_mentions: {
      parse: [],
      roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [],
      // Deduplicated: a GM who has not answered is in both lists, and Discord
      // caps this at 100 ids — a list that repeats people runs out sooner than
      // the number of people in it suggests.
      users: [...new Set([...silent.map((row) => row.userId), ...(gmId ? [gmId] : [])])],
    },
  };
}

/**
 * The nudge, as a DM. It carries no buttons, because a DM is not the attendance
 * post and every button in this repo sits on the thing it concerns — so it says
 * where to answer instead, and the link takes them there.
 */
export function remindDm(target: ProjectionTarget, hours: number): MessagePayload {
  const { session, campaign } = target;
  const where =
    campaign?.discordChannelId && session.discordMessageId
      ? `https://discord.com/channels/${GUILD_PLACEHOLDER}/${session.threadId ?? campaign.discordChannelId}/${session.discordMessageId}`
      : undefined;

  return {
    content: [
      `**${escapeMarkdown(sessionTitle(target))}** — ${inWords(hours)}.`,
      `<t:${session.startsAt}:F>. You have not said whether you are coming.`,
      ...(where ? [where] : ["Answer on the attendance post."]),
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: [] },
  };
}

/** One row of the register, as the correction post shows it. */
export interface RegisterRow {
  userId: string;
  name: string;
  attended: boolean;
  /** Whether a person said so, as opposed to Orrey having assumed it. */
  corrected: boolean;
  /**
   * What they played on a multi day, in whoever ran it's own words. Null
   * everywhere else, and null on a multi day nobody has filled it in for —
   * which is most of them, because it is optional and meant to be.
   */
  tablesPlayed?: string | null;
}

/**
 * The correction post: the register, and one toggle per person.
 *
 * Orrey assumed this from what people said, and the assumption is wrong often
 * enough to be worth a post — somebody says in and does not come, somebody turns
 * up who never clicked. The toggles are the organiser's, and each click rewrites
 * this message as its own response, which is the one rewrite send-only allows.
 *
 * Discord gives five buttons a row and five rows, so twenty-five people fit. A
 * bigger table than that says so rather than silently dropping the rest — the
 * whole point of this post is that the register is complete.
 */
/**
 * Twenty-five toggles is five rows, which is every row Discord allows — so a
 * post that also carries the **Tables played** button has room for twenty.
 *
 * Dropping five names rather than dropping the button is the right way round on
 * a multi day: the console corrects a register and there is a line on the post
 * saying so, but nothing else can record what somebody played.
 */
const MAX_TOGGLES = 25;
const MAX_TOGGLES_WITH_TABLES = 20;

export interface CorrectionOptions {
  /**
   * Whether this session is a multi game day's. Passed in rather than read off
   * the target, because the renderer is pure and because `ProjectionTarget` does
   * not know about game days until `p5/4` — this slice forks below that and has
   * no business waiting for it.
   */
  multiDay?: boolean | undefined;
}

export function correctionPost(
  target: ProjectionTarget,
  register: RegisterRow[],
  asOf: Date,
  options: CorrectionOptions = {},
): MessagePayload {
  const tables = options.multiDay === true;
  const shown = register.slice(0, tables ? MAX_TOGGLES_WITH_TABLES : MAX_TOGGLES);
  const dropped = register.length - shown.length;

  const came = register.filter((row) => row.attended);
  const lines = [
    `**Who came?** ${escapeMarkdown(sessionTitle(target))}`,
    `${came.length} of ${register.length}${came.length > 0 ? ` — ${came.map((row) => escapeMarkdown(row.name)).join(", ")}` : ""}`,
    "",
    "Orrey guessed this from what people said. Tap anybody it got wrong.",
  ];

  // Somebody else's free text on a post Orrey can never edit, so it is escaped
  // exactly like a note is — a stray backtick would break this post's layout
  // permanently.
  const played = tables ? register.filter((row) => row.tablesPlayed) : [];
  if (played.length > 0) {
    lines.push(
      "",
      "**Tables**",
      ...played.map(
        (row) => `${escapeMarkdown(row.name)} — ${escapeMarkdown(row.tablesPlayed as string)}`,
      ),
    );
  }

  if (dropped > 0) {
    lines.push(
      `-# ${dropped} more on the roster than there are buttons; correct those in the console.`,
    );
  }
  lines.push(`-# As of <t:${Math.floor(asOf.getTime() / 1000)}:R>.`);

  return {
    content: lines.join("\n"),
    components: [
      ...rowsOf(shown.map((row) => toggle(target.session.id, row))),
      ...(tables ? [tablesRow(target.session.id)] : []),
    ],
    allowed_mentions: { parse: [], roles: [] },
  };
}

/**
 * One button, and a chain that is ephemeral from there on.
 *
 * The post has already spent its component budget on one toggle per person, and
 * a modal holds five inputs — which a multi day's roster outgrows immediately.
 * So this opens an ephemeral select of the people marked attended, that select
 * opens a modal, and the modal answers ephemerally.
 *
 * The correction post itself is never rewritten by any of it. Rewriting it would
 * replace the toggles everyone else is using with one organiser's select, for
 * good. The line appears on the post's next Refresh, which is how every stale
 * reading in this repo becomes current.
 */
export function tablesRow(sessionId: string): Record<string, unknown> {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.SECONDARY,
        label: "Tables played",
        custom_id: encodeCustomId({ action: "tables", target: sessionId }),
      },
    ],
  };
}

/**
 * The same nudge for everybody Orrey could not DM, as one message in the thread.
 * One message and not one each: the thread is shared, so three separate mentions
 * of three people is three notifications for all of them.
 */
export function remindInThread(
  target: ProjectionTarget,
  hours: number,
  userIds: string[],
): MessagePayload {
  return {
    content: [
      `${userIds.map((id) => `<@${id}>`).join(" ")} — ${inWords(hours)}.`,
      `**${escapeMarkdown(sessionTitle(target))}**, <t:${target.session.startsAt}:F>.`,
      "Answering on the post above is what changes it.",
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: [], users: [...new Set(userIds)] },
  };
}

/**
 * Discord needs a guild id in a message link and the renderer is pure, so the
 * link is built with a placeholder Discord accepts: `@me` resolves to whatever
 * guild the channel is in when somebody clicks it.
 */
const GUILD_PLACEHOLDER = "@me";

function inWords(hours: number): string {
  if (hours >= 48) return `in ${Math.round(hours / 24)} days`;
  if (hours >= 24) return "tomorrow";
  if (hours === 1) return "in an hour";
  return `in ${hours} hours`;
}

function toggle(sessionId: string, row: RegisterRow): Record<string, unknown> {
  return {
    type: ComponentType.BUTTON,
    // Green for came, grey for did not. A corrected row keeps the tick that says
    // a person decided it rather than Orrey guessing.
    style: row.attended ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY,
    label: `${row.attended ? "✓" : "✗"} ${row.name}`.slice(0, 80),
    custom_id: encodeCustomId({ action: "attended", arg: row.userId, target: sessionId }),
  };
}

/** Five to a row, which is all Discord allows. */
function rowsOf(buttons: Record<string, unknown>[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: ComponentType.ACTION_ROW, components: buttons.slice(i, i + 5) });
  }
  return rows;
}
