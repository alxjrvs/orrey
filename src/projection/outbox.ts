import type { Env, OutboxMessage } from "../env.ts";

/**
 * The producer. Everything that creates or changes a session asks for a
 * projection here — phase 1's only caller is the `session.project` job the seed
 * arms, phase 2's is the horizon materialiser and the console.
 *
 * Both surfaces are asked at once and independently: Google is not downstream
 * of Discord, and one failing must not hold the other back. The message carries
 * an id and nothing else, so a projector always reads current state.
 */
export type ProjectionSurface = "discord" | "google";

const UPSERTS: Record<ProjectionSurface, OutboxMessage["kind"]> = {
  discord: "discord.event.upsert",
  google: "gcal.upsert",
};

const DELETES: Record<ProjectionSurface, OutboxMessage["kind"]> = {
  discord: "discord.event.delete",
  google: "gcal.delete",
};

export async function enqueueProjection(
  env: Env,
  sessionId: string,
  surfaces: ProjectionSurface[] = ["discord", "google"],
): Promise<void> {
  await send(env, surfaces.map((surface) => ({ kind: UPSERTS[surface], sessionId })));
}

export async function enqueueUnprojection(
  env: Env,
  sessionId: string,
  surfaces: ProjectionSurface[] = ["discord", "google"],
): Promise<void> {
  await send(env, surfaces.map((surface) => ({ kind: DELETES[surface], sessionId })));
}

async function send(env: Env, messages: OutboxMessage[]): Promise<void> {
  await env.OUTBOX.sendBatch(messages.map((body) => ({ body })));
}
