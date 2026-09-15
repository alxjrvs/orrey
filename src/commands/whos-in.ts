import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { flakeFor, flakeLine } from "../campaigns/flake.ts";
import { campaignTarget, sessionTitle } from "../projection/target.ts";
import { escapeMarkdown } from "../attendance/render.ts";
import { loadProjectionTarget } from "../projection/target.ts";

/**
 * Who is in, out and unheard-from — authoritative, not a snapshot.
 *
 * This command exists **because** posts are snapshots. An attendance post is a
 * rendering of D1 at the moment it was written, and under send-only it stays
 * that way until somebody clicks it. When it has gone stale, this is where the
 * real answer lives, so the one thing it must never do is be a snapshot itself:
 * it reads D1 at the moment it is asked and says when that was.
 *
 * Ephemeral, and it writes nothing.
 */

/** Discord's ceiling on an autocomplete response. */
export const MAX_CHOICES = 25;

export interface WhosInRow {
  userId: string;
  name: string;
  characterName: string | null;
  role: "gm" | "player" | null;
  intent: "in" | "out" | "maybe" | null;
  note: string | null;
  /** Only where there is enough history to mean anything. */
  flake?: string | undefined;
}

export interface WhosIn {
  sessionId: string;
  title: string;
  startsAt: number;
  state: string;
  rows: WhosInRow[];
}

/**
 * What the caller asked about, or refusal.
 *
 * A session on a roster the caller is not on is **refused rather than shown**.
 * The roster of somebody else's campaign is not public information, and an
 * autocomplete that only ever offers your own campaigns is a convenience, not an
 * access check — a person can type any id they like.
 */
export async function whosIn(
  env: Env,
  userId: string,
  sessionId: string | undefined,
  asOf: Date,
): Promise<WhosIn | "no-session" | "not-yours"> {
  const chosen = sessionId ?? (await nextSessionFor(env, userId, asOf))?.id;
  if (!chosen) return "no-session";

  const target = await loadProjectionTarget(env, chosen);
  if (!target) return "no-session";

  const campaignId = target.session.campaignId;
  if (!campaignId || !(await isOnRoster(env, campaignId, userId))) return "not-yours";

  const roster = await rosterOf(env, campaignId);
  const register = await db(env)
    .select({
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
      note: schema.attendance.note,
    })
    .from(schema.attendance)
    .where(eq(schema.attendance.sessionId, chosen))
    .all();

  const rows: WhosInRow[] = [];
  for (const member of roster) {
    const said = register.find((row) => row.userId === member.userId);
    rows.push({
      userId: member.userId,
      name: member.name,
      characterName: member.characterName,
      role: member.role,
      intent: said?.intent ?? null,
      note: said?.note ?? null,
      flake: flakeLine(await flakeFor(env, campaignId, member.userId)),
    });
  }

  return {
    sessionId: chosen,
    title: sessionTitle(target),
    startsAt: target.session.startsAt,
    state: target.session.state,
    rows,
  };
}

/**
 * The sessions this person could be asking about: upcoming, on a campaign they
 * are a member of, capped at Discord's 25 because an autocomplete has three
 * seconds to answer and this has to be one indexed scan.
 */
export async function sessionChoices(
  env: Env,
  userId: string,
  query: string,
  asOf: Date,
): Promise<{ name: string; value: string }[]> {
  const needle = query.trim().toLowerCase();

  // The needle has to reach the *database*, not a page of twenty-five rows.
  // Filtering after the LIMIT means the twenty-sixth-soonest session can never
  // be picked however precisely somebody types its name — which is exactly when
  // they would be typing.
  const rows = await callerSessions(env, userId, asOf, needle);

  return rows
    .map((row) => ({
      name: `${sessionTitle(campaignTarget(row.session, row.campaign))} — ${stamp(row.session.startsAt)}`.slice(0, 100),
      value: row.session.id,
    }))
    .slice(0, MAX_CHOICES);
}

/** What the caller reads. */
export function renderWhosIn(answer: WhosIn, asOf: Date): string {
  const groups: [string, WhosInRow["intent"]][] = [
    ["In", "in"],
    ["Maybe", "maybe"],
    ["Out", "out"],
    ["Not heard from", null],
  ];

  const asOfLine = `-# Read from Orrey as of <t:${Math.floor(asOf.getTime() / 1000)}:t>, not from any post.`;

  // Longest first: the whole table with notes, then without, then counts only.
  // An interaction response over Discord's ceiling is not a shortened answer, it
  // is *no answer* — the call is rejected outright — so this command needs the
  // same ladder the attendance post has.
  for (const detail of [
    { notes: true, names: true },
    { notes: false, names: true },
    { notes: false, names: false },
  ]) {
    const lines = [`**${escapeMarkdown(answer.title)}** — <t:${answer.startsAt}:F>`];
    if (answer.state !== "SCHEDULED") lines.push(`-# ${answer.state.toLowerCase()}`);

    for (const [label, intent] of groups) {
      const members = answer.rows.filter((row) => row.intent === intent);
      if (members.length === 0) continue;
      lines.push("", `**${label}** — ${members.length}`);
      // The counts are the part that must survive: a roster answer that says how
      // many are in is worth something; one that has been cut off mid-name is
      // not.
      if (detail.names) for (const member of members) lines.push(`- ${describe(member, detail)}`);
    }

    lines.push("", asOfLine);
    const content = lines.join("\n");
    if (content.length <= LIMIT) return content;
  }

  // Nothing left to drop. The header and the as-of line are the answer.
  return [`**${escapeMarkdown(answer.title)}** — <t:${answer.startsAt}:F>`, "", asOfLine].join("\n");
}

/** Discord's ceiling is 2000; the margin is for the mention expansion. */
const LIMIT = 1900;

/**
 * A name, a character name and a note are all somebody else's text, on a message
 * Orrey can never edit. Unescaped, a note reading `**Out (4)** — Bob` renders as
 * a heading of Orrey's own shape and the rest of the roster reflows under it —
 * which on the command that exists to be *authoritative* is the worst place in
 * the repo for it.
 */
function describe(row: WhosInRow, detail: { notes: boolean }): string {
  const name = escapeMarkdown(row.name);
  const parts = [row.role === "gm" ? `**${name}** (GM)` : name];
  if (row.characterName) parts.push(`as ${escapeMarkdown(row.characterName)}`);
  if (detail.notes && row.note) parts.push(`— ${escapeMarkdown(row.note)}`);
  // Information for the organiser, never a consequence: it sits after the name
  // and changes nothing about where the person is grouped.
  if (row.flake) parts.push(`-# (${row.flake})`);
  return parts.join(" ");
}

/**
 * Whether this person is on this campaign.
 *
 * Exported because an autocomplete is a convenience and not an access check: a
 * person can type any id they like, and session ids are `<campaign-slug>-s<n>`,
 * which is guessable rather than secret. Anything that discloses or changes a
 * session on somebody else's behalf asks this, not the autocomplete.
 */
export async function isOnRoster(env: Env, campaignId: string, userId: string): Promise<boolean> {
  const row = await db(env)
    .select({ userId: schema.campaignMembers.userId })
    .from(schema.campaignMembers)
    .where(
      and(
        eq(schema.campaignMembers.campaignId, campaignId),
        eq(schema.campaignMembers.userId, userId),
      ),
    )
    .get();
  return row !== undefined;
}

async function callerSessions(env: Env, userId: string, asOf: Date, needle = "") {
  return db(env)
    .select({ session: schema.sessions, campaign: schema.campaigns })
    .from(schema.campaignMembers)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignMembers.campaignId))
    .innerJoin(schema.sessions, eq(schema.sessions.campaignId, schema.campaigns.id))
    .where(
      and(
        eq(schema.campaignMembers.userId, userId),
        gte(schema.sessions.startsAt, Math.floor(asOf.getTime() / 1000)),
        ne(schema.sessions.state, "CANCELLED"),
        ne(schema.sessions.state, "PLAYED"),
        ...(needle
          ? [sql`lower(${schema.campaigns.name}) LIKE ${`%${needle.replaceAll("%", "")}%`}`]
          : []),
      ),
    )
    .orderBy(asc(schema.sessions.startsAt), asc(schema.sessions.id))
    .limit(MAX_CHOICES)
    .all();
}

async function nextSessionFor(env: Env, userId: string, asOf: Date) {
  const [first] = await callerSessions(env, userId, asOf);
  return first?.session;
}

function stamp(startsAt: number): string {
  return new Date(startsAt * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
