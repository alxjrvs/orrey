import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { InvalidGame } from "../campaigns/roster-write.ts";

/**
 * Who is holding a game, and what that means for deleting it.
 *
 * The guard is a **query, not a catch**. Reading the campaigns that point at a
 * game and refusing is what lets the page say *which* ones; catching the foreign
 * key afterwards can only say that one exists — and `games.id` is `set null` on
 * the campaign side anyway, so there is no constraint to catch: a delete would
 * simply succeed and quietly take the game off four campaigns. The refusal is
 * the only thing standing between an organiser and that.
 *
 * Game days are counted too. A day's `game_id` is `set null` for the same
 * reason, and a `single` day with no game is a day whose capacity has nothing to
 * come from.
 */
export interface GameHolder {
  id: string;
  name: string;
}

export interface GameUsage {
  campaigns: GameHolder[];
  gameDays: number;
}

export interface GameRow {
  id: string;
  name: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  defaultDurationMinutes: number | null;
  usage: GameUsage;
}

export async function gameRows(env: Env): Promise<GameRow[]> {
  const games = await db(env).select().from(schema.games).orderBy(asc(schema.games.name)).all();
  if (games.length === 0) return [];

  const ids = games.map((game) => game.id);

  // Two grouped reads rather than two per game. Five games today, but a query
  // per row is the kind of thing that is fine until it is not.
  const holders = await db(env)
    .select({ id: schema.campaigns.id, name: schema.campaigns.name, gameId: schema.campaigns.gameId })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.gameId, ids))
    .orderBy(asc(schema.campaigns.name))
    .all();

  const dayCounts = await db(env)
    .select({ gameId: schema.gameDays.gameId, n: sql<number>`count(*)` })
    .from(schema.gameDays)
    .where(inArray(schema.gameDays.gameId, ids))
    .groupBy(schema.gameDays.gameId)
    .all();

  const byGame = new Map<string, GameHolder[]>();
  for (const holder of holders) {
    if (!holder.gameId) continue;
    const list = byGame.get(holder.gameId);
    if (list) list.push({ id: holder.id, name: holder.name });
    else byGame.set(holder.gameId, [{ id: holder.id, name: holder.name }]);
  }
  const days = new Map(dayCounts.map((row) => [row.gameId ?? "", row.n]));

  return games.map((game) => ({
    id: game.id,
    name: game.name,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    defaultDurationMinutes: game.defaultDurationMinutes,
    usage: { campaigns: byGame.get(game.id) ?? [], gameDays: days.get(game.id) ?? 0 },
  }));
}

/**
 * Delete a game nobody is holding.
 *
 * Refused by name when somebody is, and the names are in the message — an
 * organiser who has to go and look up which four campaigns broke is an organiser
 * who will do it in the database instead.
 */
export async function deleteGame(env: Env, id: string, actor: string): Promise<void> {
  const game = await db(env).select().from(schema.games).where(eq(schema.games.id, id)).get();
  if (!game) throw new InvalidGame(`no game ${id}`);

  const campaigns = await db(env)
    .select({ name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.gameId, id))
    .orderBy(asc(schema.campaigns.name))
    .all();

  if (campaigns.length > 0) {
    const names = campaigns.map((row) => row.name).join(", ");
    throw new InvalidGame(
      `${game.name} is what ${names} ${campaigns.length === 1 ? "plays" : "play"}. Point ${
        campaigns.length === 1 ? "it" : "them"
      } somewhere else first.`,
    );
  }

  const days = await db(env)
    .select({ id: schema.gameDays.id })
    .from(schema.gameDays)
    .where(eq(schema.gameDays.gameId, id))
    .all();

  if (days.length > 0) {
    throw new InvalidGame(
      `${game.name} is on ${days.length} game ${days.length === 1 ? "day" : "days"}. A day without its game has no capacity to take.`,
    );
  }

  const d = db(env);
  await d.batch([
    d.delete(schema.games).where(eq(schema.games.id, id)),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: "game.delete",
      targetType: "game",
      targetId: id,
      detail: { before: game },
    }),
  ]);
}
