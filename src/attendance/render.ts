import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import { escapeMarkdown } from "../discord/markdown.ts";

export { escapeMarkdown };
import { suggestRow } from "../polls/buttons.ts";
import { quorumLine, quorumOf, type Quorum, type RuleKind } from "./quorum.ts";

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
  /**
   * Whether this person is *assigned* to the session, rather than somebody who
   * answered about it.
   *
   * Nearly everybody is both. The two come apart for exactly one person — one who
   * answered and has since left the roster — and that person is why this is a
   * field rather than an assumption. Under the veto rule a single `out` moves the
   * evening, and an `out` left behind by somebody no longer at the table would
   * move it for ever, with nothing anyone could click to put it back.
   *
   * So the rule reads this and not the answer alone: a veto is a seat saying it
   * cannot make the date. The tallies above go on counting every answer, because
   * an answer is still true of the person who gave it.
   */
  onRoster: boolean;
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
  quorum,
  asOf,
}: {
  target: ProjectionTarget;
  rows: AttendanceRow[];
  gmId: string | undefined;
  /** The verdict, so the notice says which rule found the session short. */
  quorum: Quorum;
  asOf: Date;
}): MessagePayload {
  const { session, campaign } = target;
  const silent = rows.filter((row) => row.intent === null);

  /**
   * **Who to chase, and it is not the same people under the two rules.**
   *
   * Under a quorum the answer is the silence: those are the people whose click
   * could still clear the bar, so the notice names them and pings them.
   *
   * Under the veto rule silence is already a yes. Pinging everybody who has said
   * nothing would be waking the whole table to do nothing, about an evening that
   * is not in doubt for any of them — so nobody is mentioned but the GM, who is
   * the one with something to do. The people who cannot make it are *named* and
   * not mentioned: the notice exists to move a date, not to put anybody on the
   * spot for having a Tuesday.
   */
  const veto = quorum.rule === "unanimous";
  const chased = veto ? [] : silent.map((row) => row.userId);

  const lines = veto
    ? [
        `**This one has to move.** ${escapeMarkdown(sessionTitle(target))}`,
        `<t:${session.startsAt}:F> — ${outNames(rows, quorum)} cannot make it.`,
      ]
    : [
        `**Is this one happening?** ${escapeMarkdown(sessionTitle(target))}`,
        `<t:${session.startsAt}:F> — ${tallyPhrase(quorum)}.`,
      ];

  if (!veto && silent.length > 0) {
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
      users: [...new Set([...chased, ...(gmId ? [gmId] : [])])],
    },
  };
}

/** Who vetoed it, by display name — the ids are in `quorum.vetoes`. */
function outNames(rows: AttendanceRow[], quorum: Quorum): string {
  const out = new Set(quorum.vetoes);
  const names = rows.filter((row) => out.has(row.userId)).map((row) => escapeMarkdown(row.name));
  // A veto with no row to name it cannot happen — the ids come from these rows —
  // but a notice that renders an empty list is worse than one that counts.
  if (names.length === 0) return `${out.size} of ${quorum.roster}`;
  return names.join(", ");
}

/**
 * The tally, which needs a bar to read against. `required` is null only when
 * nobody set one, and `checkJeopardy` answers `no-quorum-set` rather than
 * `in-jeopardy` in that case — so this is unreachable rather than impossible, and
 * it says the true thing instead of printing "of null".
 */
function tallyPhrase(quorum: Quorum): string {
  const { saidIn, required } = quorum;
  return required === null ? `${saidIn} in` : `${saidIn} of ${required} in`;
}

/**
 * The nudge, as a DM. It carries no buttons, because a DM is not the attendance
 * post and every button in this repo sits on the thing it concerns — so it says
 * where to answer instead, and the link takes them there.
 */
export function remindDm(
  target: ProjectionTarget,
  hours: number,
  rule: RuleKind = "quorum",
): MessagePayload {
  const { session, campaign } = target;
  const where =
    campaign?.discordChannelId && session.discordMessageId
      ? `https://discord.com/channels/${GUILD_PLACEHOLDER}/${session.threadId ?? campaign.discordChannelId}/${session.discordMessageId}`
      : undefined;

  return {
    content: [
      `**${escapeMarkdown(sessionTitle(target))}** — ${inWords(hours)}.`,
      `<t:${session.startsAt}:F>. ${nudge(rule)}`,
      ...(where ? [where] : ["Answer on the attendance post."]),
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: [] },
  };
}

/**
 * What the nudge is actually asking for, which is not the same thing under the
 * two rules.
 *
 * Under a quorum it is asking for an answer: the tally cannot clear a bar without
 * one, and somebody who has said nothing is a gap in it.
 *
 * Under the veto rule it is asking for *nothing*, and saying so is the point. They
 * are already counted in; the reminder exists because this is their last easy
 * chance to say they cannot make it, and telling somebody they "have not said" when
 * the rule already took their silence as yes is telling them to do something that
 * has no effect. It is also the sentence most likely to make a table start
 * answering a post it never had to answer.
 */
function nudge(rule: RuleKind): string {
  return rule === "unanimous"
    ? "You are down as **in** — silence counts as coming. Press **Out** only if you cannot make it."
    : "You have not said whether you are coming.";
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
  rule: RuleKind = "quorum",
): MessagePayload {
  return {
    content: [
      `${userIds.map((id) => `<@${id}>`).join(" ")} — ${inWords(hours)}.`,
      `**${escapeMarkdown(sessionTitle(target))}**, <t:${target.session.startsAt}:F>.`,
      rule === "unanimous"
        ? "You are down as in. Say so on the post above only if you cannot make it."
        : "Answering on the post above is what changes it.",
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
 * Twenty, not twenty-five, and **Recap** is why.
 *
 * Discord gives five buttons a row and five rows. Twenty-five toggles is all
 * five rows, which left nothing for a button underneath — fine while there was
 * no button underneath. Every correction post now carries one, so the toggles
 * get four rows and the sixth row that twenty-five would need does not exist:
 * Discord rejects the message outright rather than truncating it.
 *
 * Dropping five names rather than dropping the button is the right way round,
 * and for the reason the multi-day case already gave: the console corrects a
 * register and there is a line on the post saying so, but nothing else writes a
 * recap or records what somebody played.
 *
 * One number now, because **Tables played** and **Recap** share the row.
 */
const MAX_TOGGLES = 20;

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
  const shown = register.slice(0, MAX_TOGGLES);
  const dropped = register.length - shown.length;

  // The same three-pass ladder the attendance post and the signup post climb,
  // and for the same reason: over two thousand characters is not a post that
  // reads badly, it is a post Discord rejects — and `attendance.assume` would
  // retry it into the identical 400 for ever. Twenty free-text lines of a
  // hundred and forty characters each is three and a half thousand on their
  // own, so this is reachable on any real games day.
  //
  // What is shed, in order: the free text somebody typed, then the list of
  // names. The count and the toggles are what the post is for, and they survive
  // every pass.
  let content = correctionBody(target, shown, register, dropped, asOf, tables, {
    tables: true,
    names: true,
  });
  if (content.length > LIMIT) {
    content = correctionBody(target, shown, register, dropped, asOf, tables, {
      tables: false,
      names: true,
    });
  }
  if (content.length > LIMIT) {
    content = correctionBody(target, shown, register, dropped, asOf, tables, {
      tables: false,
      names: false,
    });
  }

  return {
    content,
    components: [
      ...rowsOf(shown.map((row) => toggle(target.session.id, row))),
      afterRow(target.session.id, tables),
    ],
    allowed_mentions: { parse: [], roles: [] },
  };
}

function correctionBody(
  target: ProjectionTarget,
  shown: RegisterRow[],
  register: RegisterRow[],
  dropped: number,
  asOf: Date,
  tables: boolean,
  detail: { tables: boolean; names: boolean },
): string {
  const came = register.filter((row) => row.attended);
  const names =
    detail.names && came.length > 0
      ? ` — ${came.map((row) => escapeMarkdown(row.name)).join(", ")}`
      : "";
  const lines = [
    `**Who came?** ${escapeMarkdown(sessionTitle(target))}`,
    `${came.length} of ${register.length}${names}`,
    "",
    "Orrey guessed this from what people said. Tap anybody it got wrong.",
  ];

  // Somebody else's free text on a post Orrey can never edit, so it is escaped
  // exactly like a note is — a stray backtick would break this post's layout
  // permanently. Only the rows with a toggle on this post: a name in the block
  // that has no button beside it is a correction nobody can make from here.
  const played = tables ? shown.filter((row) => row.tablesPlayed) : [];
  if (played.length > 0) {
    lines.push(
      "",
      "**Tables**",
      ...(detail.tables
        ? played.map(
            (row) => `${escapeMarkdown(row.name)} — ${escapeMarkdown(row.tablesPlayed as string)}`,
          )
        : // Shed rather than silently gone: the lines are on the register, and
          // the console is where a post this long gets read anyway.
          [`-# ${played.length} recorded — read them in the console.`]),
    );
  }

  if (dropped > 0) {
    lines.push(
      `-# ${dropped} more on the roster than there are buttons; correct those in the console.`,
    );
  }
  lines.push(`-# As of <t:${Math.floor(asOf.getTime() / 1000)}:R>.`);

  return lines.join("\n");
}

/**
 * The row under the toggles: **Recap** always, **Tables played** on a multi day.
 *
 * One row rather than two, because a row holds five buttons and the toggles
 * above have already spent most of the post's component budget — a second row
 * for one button would cost a toggle.
 */
export function afterRow(sessionId: string, tables: boolean): Record<string, unknown> {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      ...(tables ? (tablesRow(sessionId).components as Record<string, unknown>[]) : []),
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.SECONDARY,
        label: "Recap",
        custom_id: encodeCustomId({ action: "recap", target: sessionId }),
      },
    ],
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
 * good. The line appears on the post's next Refresh, which is beside it.
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
      // What "it will be on the post on its next Refresh" refers to. Without it
      // there is no next render of this post at all: the correction post has no
      // other button that rewrites it, and send-only means nothing else can.
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.SECONDARY,
        label: "Refresh",
        custom_id: encodeCustomId({ action: "correction", arg: "refresh", target: sessionId }),
      },
    ],
  };
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

/**
 * "It's off." One new message in the session's thread.
 *
 * Never an edit of the attendance post. That post renders from D1, so the next
 * click on it shows the new state on its own — and under send-only there is no
 * rewriting it from outside anyway. This is what "anything changing from outside
 * posts a new notice" means for a cancellation.
 */
export function cancelledSessionNotice(target: ProjectionTarget): MessagePayload {
  const { session, campaign } = target;
  return {
    content: [
      `**It's off.** ${escapeMarkdown(sessionTitle(target))} is not happening.`,
      `It was <t:${session.startsAt}:F>${session.location ? `, ${escapeMarkdown(session.location)}` : ""}.`,
      "",
      "-# The calendar entries have been taken down.",
    ].join("\n"),
    components: [],
    // The roster, because they were going to turn up. Nothing else can fire.
    allowed_mentions: { parse: [], roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [] },
  };
}
