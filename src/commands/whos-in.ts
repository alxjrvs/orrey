import { and, asc, eq, gte, ne } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { flakeFor, flakeLine } from "../campaigns/flake.ts";
import { sessionTitle } from "../projection/target.ts";
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
  const rows = await callerSessions(env, userId, asOf);
  const needle = query.trim().toLowerCase();

  return rows
    .map((row) => ({
      name: `${sessionTitle(row)} — ${stamp(row.session.startsAt)}`.slice(0, 100),
      value: row.session.id,
    }))
    .filter((choice) => !needle || choice.name.toLowerCase().includes(needle))
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

  const lines = [`**${answer.title}** — <t:${answer.startsAt}:F>`];
  if (answer.state !== "SCHEDULED") lines.push(`-# ${answer.state.toLowerCase()}`);

  for (const [label, intent] of groups) {
    const members = answer.rows.filter((row) => row.intent === intent);
    if (members.length === 0) continue;
    lines.push("", `**${label}** — ${members.length}`);
    for (const member of members) lines.push(`- ${describe(member)}`);
  }

  lines.push(
    "",
    `-# Read from Orrey as of <t:${Math.floor(asOf.getTime() / 1000)}:t>, not from any post.`,
  );
  return lines.join("\n");
}

function describe(row: WhosInRow): string {
  const parts = [row.role === "gm" ? `**${row.name}** (GM)` : row.name];
  if (row.characterName) parts.push(`as ${row.characterName}`);
  if (row.note) parts.push(`— ${row.note}`);
  // Information for the organiser, never a consequence: it sits after the name
  // and changes nothing about where the person is grouped.
  if (row.flake) parts.push(`-# (${row.flake})`);
  return parts.join(" ");
}

async function isOnRoster(env: Env, campaignId: string, userId: string): Promise<boolean> {
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

async function callerSessions(env: Env, userId: string, asOf: Date) {
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
