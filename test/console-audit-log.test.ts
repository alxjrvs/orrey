import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { auditActors, auditLine, auditPage, type AuditRow } from "../src/console/audit.ts";

/**
 * The audit log.
 *
 * Two things can be wrong with it and both are invisible from the page: the
 * pager can skip or repeat a row, and the gate can be re-decided per row. An
 * audit log grows at the head, so the pager is tested against a write landing
 * between two fetches — which is the ordinary case, not an edge one.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T18:51:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const ORGANISER_ROLE = "role-organiser";

let roles = [ORGANISER_ROLE];

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function get(path: string) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}` },
    }),
    consoleEnv(),
  );
}

async function person(id: string, name: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, globalName: name, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

/** One entry. `at` is seconds from NOW, so a whole page can share a second. */
async function entry(
  id: string,
  at: number,
  over: Partial<typeof schema.auditLog.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.auditLog)
    .values({
      id,
      actorUserId: "1001",
      action: "campaign.update",
      targetType: "campaign",
      targetId: "age-of-umbra",
      createdAt: seconds + at,
      ...over,
    });
  return id;
}

beforeEach(async () => {
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of ["audit_log", "discord_tokens", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await person("1001", "alx");
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the pager", () => {
  it("neither skips nor repeats when something is written between two pages", async () => {
    for (let i = 0; i < 6; i++) await entry(`e${i}`, i);

    const first = await auditPage(env, { limit: 3 });
    expect(first.rows.map((row) => row.id)).toEqual(["e5", "e4", "e3"]);
    expect(first.cursor).not.toBeNull();

    // The log grows at the head while somebody is reading it. This is the
    // ordinary case for an audit log, not an edge one — and it is exactly what
    // `LIMIT 3 OFFSET 3` gets wrong, shifting every later row down by one and
    // showing `e3` twice.
    await entry("e6", 6);

    const second = await auditPage(env, { limit: 3, cursor: first.cursor ?? undefined });

    expect(second.rows.map((row) => row.id)).toEqual(["e2", "e1", "e0"]);
    expect(second.cursor).toBeNull();
  });

  it("pages through rows written in the same second", async () => {
    for (const id of ["a", "b", "c", "d"]) await entry(id, 0);

    const first = await auditPage(env, { limit: 2 });
    const second = await auditPage(env, { limit: 2, cursor: first.cursor ?? undefined });

    // The tie-break on id is the only thing making this pageable. Without it a
    // cursor of "older than this second" would skip the rest of the second.
    const seen = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual(["d", "c", "b", "a"]);
  });

  it("says there is no next page rather than returning an empty one", async () => {
    await entry("only", 0);
    expect((await auditPage(env, { limit: 3 })).cursor).toBeNull();
  });

  it("ignores a cursor it did not mint", async () => {
    await entry("e0", 0);
    expect((await auditPage(env, { cursor: "nonsense" })).rows).toHaveLength(1);
  });
});

describe("filtering", () => {
  it("returns only that actor's rows", async () => {
    await person("2002", "bea");
    await entry("mine", 0);
    await entry("theirs", 1, { actorUserId: "2002" });
    await entry("the clock", 2, { actorUserId: null });

    const page = await auditPage(env, { actorUserId: "2002" });
    expect(page.rows.map((row) => row.id)).toEqual(["theirs"]);
  });

  it("returns only that target's rows", async () => {
    await entry("campaign", 0);
    await entry("game", 1, { targetType: "game", targetId: "blades" });

    expect((await auditPage(env, { targetType: "game" })).rows.map((r) => r.id)).toEqual(["game"]);
  });

  it("lists the actors that appear, and never the clock", async () => {
    await person("2002", "bea");
    await entry("mine", 0);
    await entry("theirs", 1, { actorUserId: "2002" });
    await entry("clock", 2, { actorUserId: null });

    // Null is the clock. It acts on nobody's behalf, so it is not somebody you
    // can filter by.
    expect(await auditActors(env)).toEqual([
      { userId: "1001", name: "alx" },
      { userId: "2002", name: "bea" },
    ]);
  });
});

describe("the line", () => {
  const base: AuditRow = {
    id: "e",
    actorUserId: "1001",
    actorName: "alx",
    action: "campaign.state",
    targetType: "campaign",
    targetId: "age-of-umbra",
    detail: { before: "RUNNING", after: "HIATUS" },
    createdAt: seconds,
  };

  it("reads in the log's own register", async () => {
    expect(auditLine(base)).toBe("18:51 alx → campaign age-of-umbra state running → hiatus");
  });

  it("has no arrow when there is nothing on the left of it", async () => {
    // A creation has no previous value, and "→ hiatus" with a space in front
    // reads as a missing word rather than as an absence.
    expect(auditLine({ ...base, detail: { before: null, after: "FORMING" } })).toBe(
      "18:51 alx → campaign age-of-umbra state forming",
    );
  });

  it("says orrey when the clock did it", async () => {
    expect(auditLine({ ...base, actorUserId: null, actorName: null, detail: null })).toContain(
      "orrey →",
    );
  });

  it("leaves a whole-row diff out of the line", async () => {
    // `{ before: {…}, after: {…} }` is a row, not a transition. The line says
    // the action happened; the diff is for whoever opens the row.
    expect(
      auditLine({ ...base, action: "game.update", detail: { before: { name: "a" }, after: { name: "b" } } }),
    ).toBe("18:51 alx → campaign age-of-umbra update");
  });

  it("renders in the zone it is given", async () => {
    expect(auditLine(base, "Pacific/Auckland")).toMatch(/^06:51 /);
  });
});

describe("the gate", () => {
  it("is on the route, and refuses the whole view", async () => {
    await entry("e0", 0);
    roles = [];

    // Asked once, for the request. A gate asked per row is a filter, and a
    // filter with a bug shows one row too many.
    expect((await get("/api/audit")).status).toBe(403);
    expect((await get("/api/audit/actors")).status).toBe(403);
  });

  it("answers an organiser with the page and its cursor", async () => {
    for (let i = 0; i < 3; i++) await entry(`e${i}`, i);

    const res = await get("/api/audit?limit=2");
    const body = (await res.json()) as { rows: AuditRow[]; cursor: string | null };

    expect(res.status).toBe(200);
    expect(body.rows.map((row) => row.id)).toEqual(["e2", "e1"]);
    expect(body.cursor).not.toBeNull();
  });
});
