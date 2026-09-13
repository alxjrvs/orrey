import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, OutboxMessage } from "../src/env.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { handleQueueBatch, project } from "../src/queue/consumer.ts";
import { enqueueProjection, enqueueUnprojection } from "../src/projection/outbox.ts";
import {
  discordFingerprint,
  googleFingerprint,
  loadProjectionTarget,
  sessionTitle,
} from "../src/projection/target.ts";
import { seedStatements } from "../src/db/seed-sql.ts";

/** A queue binding that records instead of sending. */
function outbox() {
  const sent: OutboxMessage[] = [];
  const queue = {
    send: async (body: OutboxMessage) => void sent.push(body),
    sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
      for (const { body } of batch) sent.push(body);
    },
  };
  return { sent, env: { ...env, OUTBOX: queue as unknown as Env["OUTBOX"] } as Env };
}

/** A batch shaped the way the runtime hands one over, with ack/retry watched. */
function batchOf(...bodies: OutboxMessage[]) {
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: { queue: "orrey-outbox", messages } as unknown as MessageBatch<OutboxMessage>,
    messages,
  };
}

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

const SESSION_ID = "age-of-umbra-s12";

/** This file is about the outbox; the seed's other job is the post, not this. */
async function onlyProjectionJobs(): Promise<void> {
  await env.DB.prepare("DELETE FROM jobs WHERE kind <> 'session.project'").run();
}

async function seed(over: Partial<typeof session> = {}): Promise<void> {
  for (const statement of seedStatements(campaign, { ...session, ...over })) {
    await env.DB.prepare(statement).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
});

describe("the producer", () => {
  it("asks both surfaces at once — neither is downstream of the other", async () => {
    const { sent, env: testEnv } = outbox();
    await enqueueProjection(testEnv, SESSION_ID);

    expect(sent).toEqual([
      { kind: "discord.event.upsert", sessionId: SESSION_ID },
      { kind: "gcal.upsert", sessionId: SESSION_ID },
    ]);
  });

  it("can ask one surface alone, and can ask for an unprojection", async () => {
    const { sent, env: testEnv } = outbox();
    await enqueueProjection(testEnv, SESSION_ID, ["google"]);
    await enqueueUnprojection(testEnv, SESSION_ID, ["discord"]);

    expect(sent).toEqual([
      { kind: "gcal.upsert", sessionId: SESSION_ID },
      { kind: "discord.event.delete", sessionId: SESSION_ID },
    ]);
  });

  it("carries an id and nothing else, so a projector always reads current state", async () => {
    const { sent, env: testEnv } = outbox();
    await enqueueProjection(testEnv, SESSION_ID, ["discord"]);

    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["kind", "sessionId"]);
  });
});

describe("the job that arms it", () => {
  it("turns the seed's standing job into outbox messages, once", async () => {
    await seed();
    // The seed also arms the attendance post; that one has its own test file.
    await onlyProjectionJobs();
    const { sent, env: testEnv } = outbox();

    expect(await drainJobs(testEnv)).toBe(1);
    expect(sent.map((m) => m.kind)).toEqual(["discord.event.upsert", "gcal.upsert"]);

    // The job is done; the next minute's drain does not re-project.
    sent.length = 0;
    expect(await drainJobs(testEnv)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("is re-armed by a re-seed, so a moved session projects again", async () => {
    await seed();
    await onlyProjectionJobs();
    const { sent, env: testEnv } = outbox();
    await drainJobs(testEnv);

    await seed({ startsAt: session.startsAt + 86_400, endsAt: session.endsAt + 86_400 });
    await onlyProjectionJobs();
    sent.length = 0;

    expect(await drainJobs(testEnv)).toBe(1);
    expect(sent).toHaveLength(2);
    // Still one job row — re-armed in place, not a second one piling up.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("the consumer spine", () => {
  it("acks a message whose session is gone rather than filling the DLQ", async () => {
    const { batch, messages } = batchOf({ kind: "gcal.upsert", sessionId: "no-such-session" });
    await handleQueueBatch(batch, env, {} as ExecutionContext);

    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("retries when a projection throws, and does not ack it", async () => {
    await seed();
    const broken = {
      ...env,
      DB: { prepare: () => { throw new Error("D1 is having a moment"); } },
    } as unknown as Env;

    const { batch, messages } = batchOf({ kind: "discord.event.upsert", sessionId: SESSION_ID });
    await handleQueueBatch(batch, broken, {} as ExecutionContext);

    expect(messages[0]?.retry).toHaveBeenCalledOnce();
    expect(messages[0]?.ack).not.toHaveBeenCalled();
  });

  it("handles every message in a batch independently", async () => {
    await seed();
    // The first cannot be projected — no guild id has been seeded, so the
    // Discord projector throws. The second has no session at all. One retries,
    // one acks, and neither decides anything for the other.
    const { batch, messages } = batchOf(
      { kind: "discord.event.upsert", sessionId: SESSION_ID },
      { kind: "gcal.upsert", sessionId: "no-such-session" },
    );
    await handleQueueBatch(batch, env, {} as ExecutionContext);

    expect(messages[0]?.retry).toHaveBeenCalledOnce();
    expect(messages[0]?.ack).not.toHaveBeenCalled();
    expect(messages[1]?.ack).toHaveBeenCalledOnce();
    expect(messages[1]?.retry).not.toHaveBeenCalled();
  });

  it("still retracts what a concluded campaign already published", async () => {
    await seed();
    await env.DB.prepare("UPDATE campaigns SET state = 'CONCLUDED'").run();

    // The upsert is gated — nothing new gets published. The delete is not, or a
    // concluded campaign's events would stay up forever with an ack saying the
    // work was done. Neither projector can run here (no guild id, no calendar),
    // so reaching them at all is what the throw proves.
    await expect(project({ kind: "gcal.upsert", sessionId: SESSION_ID }, env)).resolves.toBeUndefined();
    await expect(project({ kind: "gcal.delete", sessionId: SESSION_ID }, env)).rejects.toThrow();
    await expect(
      project({ kind: "discord.event.delete", sessionId: SESSION_ID }, env),
    ).rejects.toThrow(/discord.guild_id/);
  });

  it("does not project a campaign that is no longer running", async () => {
    await seed();
    await env.DB.prepare("UPDATE campaigns SET state = 'CONCLUDED'").run();

    const target = await loadProjectionTarget(env, SESSION_ID);
    expect(target?.campaign?.state).toBe("CONCLUDED");
    // Nothing throws, nothing is written: a redelivered message for a concluded
    // campaign must not put its old sessions back on a calendar.
    await expect(project({ kind: "gcal.upsert", sessionId: SESSION_ID }, env)).resolves.toBeUndefined();
  });

  it("reads the session from D1 every time, not from the message", async () => {
    await seed();
    const before = await loadProjectionTarget(env, SESSION_ID);
    await env.DB.prepare("UPDATE sessions SET starts_at = starts_at + 3600").run();
    const after = await loadProjectionTarget(env, SESSION_ID);

    expect(after?.session.startsAt).toBe((before?.session.startsAt ?? 0) + 3600);
  });
});

describe("the fingerprint", () => {
  it("is stable for equal content and moves when the session moves", async () => {
    await seed();
    const first = await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!);
    const again = await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!);
    expect(again).toBe(first);

    await seed({ startsAt: session.startsAt + 3600 });
    const moved = await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!);
    expect(moved).not.toBe(first);
  });

  it("covers the location, which is what an EXTERNAL event shows", async () => {
    await seed();
    const before = await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!);

    await seed({ location: "Somewhere else" });
    expect(await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!)).not.toBe(before);
  });

  it("is per surface: a voice-channel change is Discord's business alone", async () => {
    await seed();
    const before = await loadProjectionTarget(env, SESSION_ID);
    const google = await googleFingerprint(before!);
    const discord = await discordFingerprint(before!);

    await env.DB.prepare(
      "UPDATE campaigns SET location_type = 'voice', discord_voice_channel_id = '900'",
    ).run();
    const after = (await loadProjectionTarget(env, SESSION_ID))!;

    // Discord renders it, so Discord rewrites. Google never showed it, and a
    // pointless write there moves `updated` for phase 7 to explain away.
    expect(await discordFingerprint(after)).not.toBe(discord);
    expect(await googleFingerprint(after)).toBe(google);
  });

  it("titles a numbered session after its campaign", async () => {
    await seed();
    const target = (await loadProjectionTarget(env, SESSION_ID))!;
    expect(sessionTitle(target)).toBe("Age of Umbra — Session 12");
    expect(sessionTitle({ ...target, campaign: null })).toBe("Session — The Wreck");
  });
});
