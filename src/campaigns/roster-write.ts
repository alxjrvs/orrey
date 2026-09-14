import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { mintFeedToken } from "../db/users.ts";
import { InvalidCampaign } from "./write.ts";

/**
 * The roster, edited from the console. Same shape as every other write here: the
 * domain function does the work and puts its audit row in the same batch.
 *
 * A person is added by Discord id, because that is the only identity Orrey has.
 * They may well not be in `users` yet — somebody can be put on a roster before
 * they have ever clicked anything — so the row is made if it is missing, with no
 * names in it. The names are a cache, and Orrey learns them the first time that
 * person speaks to it.
 */
async function ensureUser(env: Env, discordId: string): Promise<void> {
  await db(env)
    .insert(schema.users)
    .values({ discordId, feedToken: mintFeedToken() })
    .onConflictDoNothing();
}

export interface MemberInput {
  userId: string;
  role?: "gm" | "player";
  characterName?: string | null;
}

const ROLES = ["gm", "player"] as const;

export async function putMember(
  env: Env,
  campaignId: string,
  input: MemberInput,
  actor: string,
): Promise<void> {
  if (!input.userId?.trim()) throw new InvalidCampaign("a roster row needs a Discord id");
  // The column has no CHECK behind it — `campaign_members` could have kept one,
  // but the type is the only thing standing between JSON and the row, and a type
  // does not survive `await c.req.json()`. "OWNER" used to be stored happily.
  if (input.role !== undefined && !ROLES.includes(input.role)) {
    throw new InvalidCampaign(`a roster role is gm or player — not ${JSON.stringify(input.role)}`);
  }

  const campaign = await db(env)
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();
  if (!campaign) throw new InvalidCampaign(`no campaign ${campaignId}`);

  await ensureUser(env, input.userId);

  const before = await db(env)
    .select()
    .from(schema.campaignMembers)
    .where(
      and(
        eq(schema.campaignMembers.campaignId, campaignId),
        eq(schema.campaignMembers.userId, input.userId),
      ),
    )
    .get();

  const row = {
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.characterName === undefined ? {} : { characterName: input.characterName }),
  };

  const d = db(env);
  await d.batch([
    d
      .insert(schema.campaignMembers)
      .values({ campaignId, userId: input.userId, ...row })
      .onConflictDoUpdate({
        target: [schema.campaignMembers.campaignId, schema.campaignMembers.userId],
        // An upsert that was told nothing still has to be a valid `set`, and
        // touching `joined_at` would rewrite when somebody joined.
        set: Object.keys(row).length > 0 ? row : { userId: input.userId },
      }),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: before ? "member.update" : "member.add",
      targetType: "campaign",
      targetId: campaignId,
      detail: {
        userId: input.userId,
        before: before ? { role: before.role, characterName: before.characterName } : null,
        after: row,
      },
    }),
  ]);
}

export async function removeMember(
  env: Env,
  campaignId: string,
  userId: string,
  actor: string,
): Promise<void> {
  const d = db(env);
  const where = and(
    eq(schema.campaignMembers.campaignId, campaignId),
    eq(schema.campaignMembers.userId, userId),
  );

  const existing = await d.select().from(schema.campaignMembers).where(where).get();

  // Nobody was on the roster to remove. Not an error — the outcome asked for is
  // the outcome — but not history either.
  if (!existing) return;

  // The delete and its audit row go together, like every other write in this
  // phase. Removing somebody and then failing to record it is the one outcome
  // the log cannot be read around afterwards.
  await d.batch([
    d.delete(schema.campaignMembers).where(where),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: "member.remove",
      targetType: "campaign",
      targetId: campaignId,
      detail: { userId, before: { role: existing.role, characterName: existing.characterName } },
    }),
  ]);
}

/**
 * Leaving the roster is not the same as never having been on it. Their
 * attendance rows stay — they answered, and that answer is still true of them —
 * which is the same reasoning `attendanceRows` uses when it keeps somebody who
 * answered and then left.
 */
export function rosterRows(env: Env, campaignId: string) {
  return db(env)
    .select({
      userId: schema.campaignMembers.userId,
      role: schema.campaignMembers.role,
      characterName: schema.campaignMembers.characterName,
      joinedAt: schema.campaignMembers.joinedAt,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.campaignMembers)
    .leftJoin(schema.users, eq(schema.campaignMembers.userId, schema.users.discordId))
    .where(eq(schema.campaignMembers.campaignId, campaignId))
    .orderBy(schema.campaignMembers.joinedAt)
    .all();
}

export interface GameInput {
  name: string;
  minPlayers?: number | null;
  maxPlayers?: number | null;
  defaultDurationMinutes?: number | null;
}

export class InvalidGame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGame";
  }
}

function validateGame(input: Partial<GameInput>): void {
  // Required, not merely non-empty. Without a name a create reached
  // `slug(undefined)` and an edit wrote `name: undefined`, which drizzle drops —
  // so the request said it had worked and had changed nothing.
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new InvalidGame("a game needs a name");
  }
  for (const field of ["minPlayers", "maxPlayers", "defaultDurationMinutes"] as const) {
    const value = input[field];
    if (value != null && value <= 0) throw new InvalidGame(`${field} must be positive`);
  }
  // The CHECK on `games` says this too — it is a new table, so it could keep one
  // — and saying it here as well is what turns a constraint failure into a
  // sentence somebody can act on.
  if (input.minPlayers != null && input.maxPlayers != null && input.minPlayers > input.maxPlayers) {
    throw new InvalidGame("a game cannot need more players than it seats");
  }
}

export async function putGame(
  env: Env,
  id: string | undefined,
  input: GameInput,
  actor: string,
): Promise<string> {
  validateGame(input);

  const gameId = id ?? slug(input.name);
  const before = await db(env)
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, gameId))
    .get();

  const row = {
    name: input.name,
    ...(input.minPlayers === undefined ? {} : { minPlayers: input.minPlayers }),
    ...(input.maxPlayers === undefined ? {} : { maxPlayers: input.maxPlayers }),
    ...(input.defaultDurationMinutes === undefined
      ? {}
      : { defaultDurationMinutes: input.defaultDurationMinutes }),
  };

  const d = db(env);
  await d.batch([
    d
      .insert(schema.games)
      .values({ id: gameId, ...row })
      .onConflictDoUpdate({
        target: schema.games.id,
        set: { ...row, updatedAt: sql`(unixepoch())` },
      }),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: before ? "game.update" : "game.create",
      targetType: "game",
      targetId: gameId,
      detail: { before: before ?? null, after: row },
    }),
  ]);

  return gameId;
}

function slug(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!out) throw new InvalidGame(`cannot make an id out of ${JSON.stringify(name)}`);
  return out;
}
