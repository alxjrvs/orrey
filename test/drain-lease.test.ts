import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { drainJobs } from "../src/jobs/drain.ts";

/**
 * The lease, and the half of it that was never collected.
 *
 * `claimed_until` was written on every claim and read by nothing, so a job whose
 * isolate died mid-run — a cron invocation evicted, a CPU limit — stayed
 * `claimed` for ever and no later drain looked at it again. A lease nobody
 * collects is not a lease, it is a way to lose a job permanently.
 */
const NOW = () => Math.floor(Date.now() / 1000);

function jobs() {
  return db(env).select().from(schema.jobs).all();
}

/** A job kind the drain acks without doing anything, so this tests the claim. */
async function arm(id: string, over: Partial<typeof schema.jobs.$inferInsert> = {}) {
  await db(env)
    .insert(schema.jobs)
    .values({
      id,
      kind: "session.project",
      payload: { sessionId: "nothing" },
      idempotencyKey: id,
      runAt: NOW() - 60,
      ...over,
    });
}

beforeEach(async () => {
  for (const table of ["jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("a job whose lease has run out", () => {
  it("is picked up again", async () => {
    // The shape a dead isolate leaves behind: claimed, and nobody coming back.
    await arm("stuck", { state: "claimed", claimedUntil: NOW() - 1, attempts: 1 });

    await drainJobs(env);

    // `session.project` for a session that does not exist enqueues nothing and
    // returns, so the drain marks it done — the point is that it ran at all.
    expect((await jobs())[0]).toMatchObject({ id: "stuck", state: "done" });
  });

  it("counts the retry, so the backoff stays honest", async () => {
    await arm("stuck", { state: "claimed", claimedUntil: NOW() - 1, attempts: 2 });

    await drainJobs(env);

    expect((await jobs())[0]?.attempts).toBe(3);
  });

  it("is left alone while the lease is still good", async () => {
    // Another drain is holding it. Taking it now is what the lease exists to
    // prevent — a slow run and the next tick both executing one job.
    await arm("held", { state: "claimed", claimedUntil: NOW() + 300, attempts: 1 });

    await drainJobs(env);

    expect((await jobs())[0]).toMatchObject({ state: "claimed", attempts: 1 });
  });

  it("is left alone when it is not due yet, lease or no lease", async () => {
    await arm("later", { state: "claimed", claimedUntil: NOW() - 1, runAt: NOW() + 600 });

    await drainJobs(env);

    expect((await jobs())[0]?.state).toBe("claimed");
  });

  it("still takes an ordinary pending job", async () => {
    await arm("fresh");

    await drainJobs(env);

    expect((await jobs())[0]?.state).toBe("done");
  });
});

describe("what the claim writes", () => {
  it("moves the lease forward, so a concurrent drain matches nothing", async () => {
    await arm("stuck", { state: "claimed", claimedUntil: NOW() - 1 });
    const before = NOW();

    // A job that throws stays visible as `pending` with its error; what matters
    // here is that the claim happened at all, which the attempt count shows.
    await drainJobs(env);

    const row = await db(env).select().from(schema.jobs).where(eq(schema.jobs.id, "stuck")).get();
    expect(row?.attempts).toBe(1);
    expect(row?.claimedUntil ?? 0).toBeGreaterThanOrEqual(before);
  });
});
