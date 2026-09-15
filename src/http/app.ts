import { Hono } from "hono";
import type { Env } from "../env.ts";
import { verifyDiscordRequest } from "../discord/verify.ts";
import { handleInteraction } from "../discord/interactions.ts";
import type { Interaction } from "../discord/types.ts";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  clear,
  mintState,
  readCookie,
  sessionCookie,
  stateCookie,
  issueSession,
} from "../console/cookies.ts";
import { authorizeUrl, exchangeCode, identify, storeTokens } from "../console/oauth.ts";
import { sessionFrom } from "../console/session.ts";
import { NotConfigured, isOrganiser } from "../console/roles.ts";
import { readLoginToken } from "../console/link.ts";
import { campaignSummaries, gameDaySummaries, gameSummaries } from "../console/api.ts";
import { campaignPage } from "../console/campaign.ts";
import { campaignHistory } from "../console/campaign-history.ts";
import { agendaBetween, windowAround } from "../console/agenda.ts";
import { sessionDetail } from "../console/session-detail.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { openPollFromConsole } from "../console/polls.ts";
import { InvalidCampaign, createCampaign, updateCampaign } from "../campaigns/write.ts";
import { IllegalTransition, transition, type CampaignState } from "../campaigns/lifecycle.ts";
import {
  IllegalDayTransition,
  transition as transitionGameDay,
  type GameDayState,
} from "../game-days/lifecycle.ts";
import {
  InvalidGame,
  putGame,
  putMember,
  removeMember,
  rosterRows,
} from "../campaigns/roster-write.ts";

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

  app.get("/healthz", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

  /**
   * Discord interactions. Signature first, always — Discord probes this
   * endpoint with a bad signature and requires a 401 before it will accept
   * the URL, which is why the Worker has to be deployed before cutover.
   */
  app.post("/interactions", async (c) => {
    const body = await c.req.text();
    const valid = await verifyDiscordRequest(
      c.env.DISCORD_PUBLIC_KEY,
      c.req.header("x-signature-ed25519") ?? null,
      c.req.header("x-signature-timestamp") ?? null,
      body,
    );
    if (!valid) return c.text("invalid request signature", 401);

    const response = await handleInteraction(JSON.parse(body) as Interaction, c.env, {
      origin: new URL(c.req.url).origin,
    });
    return c.json(response);
  });

  /**
   * Console login, Discord OAuth, `identify` scope and nothing else.
   *
   * The `state` is minted here and set as a short-lived cookie; the callback
   * refuses to exchange anything until the two match. Without it, anybody could
   * hand somebody a callback URL carrying their own code and have the victim's
   * browser log in as them.
   */
  app.get("/console/login", async (c) => {
    // The console has no public front door. A redirect to Discord's authorize
    // endpoint that anybody can trigger is a phishing primitive rather than a
    // convenience, so the link has to have come from `/console` just now.
    if (!(await readLoginToken(c.env, c.req.query("t"), new Date()))) {
      return c.text("That login link has expired. Run /console in Discord again.", 400);
    }

    const state = mintState();
    c.header("set-cookie", stateCookie(state));
    return c.redirect(authorizeUrl(c.env, new URL(c.req.url).origin, state), 302);
  });

  app.get("/console/callback", async (c) => {
    const code = c.req.query("code");
    const returned = c.req.query("state");
    const expected = readCookie(c.req.header("cookie"), STATE_COOKIE);

    // The state check comes first, before the code is worth anything. One
    // response for every way this can fail: saying which half was wrong tells
    // somebody guessing which half to keep.
    if (!code || !returned || !expected || returned !== expected) {
      c.header("set-cookie", clear(STATE_COOKIE));
      return c.text("That login link did not check out. Run /console again.", 400);
    }

    const origin = new URL(c.req.url).origin;
    try {
      const pair = await exchangeCode(c.env, origin, code);
      const user = await identify(pair.accessToken);
      await storeTokens(c.env, user, pair);

      c.header("set-cookie", clear(STATE_COOKIE));
      c.header("set-cookie", sessionCookie(await issueSession(c.env, user.id, new Date())), {
        append: true,
      });
      return c.redirect("/console", 302);
    } catch (error) {
      console.error("console login failed", error);
      c.header("set-cookie", clear(STATE_COOKIE));
      return c.text("Discord would not complete that login. Run /console again.", 502);
    }
  });

  /**
   * The gate every administering route sits behind.
   *
   * It answers 403 rather than redirecting, because the caller is `fetch` from
   * the SPA and a 302 to Discord would arrive as an opaque CORS failure rather
   * than as "you are not allowed to do that".
   *
   * The role is read fresh, with the bot token, on every request. Nothing is
   * carried in the cookie and nothing is cached, so a role removed in Discord is
   * a permission gone on the next request rather than on the next login.
   */
  app.use("/api/*", async (c, next) => {
    const session = await sessionFrom(c.env, c.req.header("cookie"), new Date());
    if (!session) return c.json({ error: "Not signed in. Run /console in Discord." }, 401);

    try {
      if (!(await isOrganiser(c.env, session.userId))) {
        return c.json({ error: "That is an organiser's to do." }, 403);
      }
    } catch (error) {
      // Orrey does not know which role administers, so nobody does. A 503 says
      // that plainly rather than answering 403 and sending somebody hunting for
      // a permission they already have.
      if (!(error instanceof NotConfigured)) throw error;
      return c.json({ error: error.message }, 503);
    }

    c.set("userId", session.userId);
    await next();
    return undefined;
  });

  /** Who Orrey thinks you are. The first thing the console asks. */
  app.get("/api/me", (c) => c.json({ userId: c.get("userId") }));

  // The read half of the console. Every field comes from D1: a console that read
  // Discord back would be showing a projection as though it were the thing.
  app.get("/api/campaigns", async (c) => c.json({ campaigns: await campaignSummaries(c.env) }));
  app.get("/api/games", async (c) => c.json({ games: await gameSummaries(c.env) }));
  app.get("/api/game-days", async (c) => c.json({ gameDays: await gameDaySummaries(c.env) }));

  /**
   * What is on, between these two moments.
   *
   * The window is the caller's to choose, half-open, so the month grid can ask
   * for a month that has already been. The default is the fortnight ahead, which
   * is what the agenda opens on.
   *
   * The envelope is `{ asOf, rows }` and every page of the console reuses it:
   * the console carries the same as-of line the Discord posts do, because what
   * it shows is a reading and the reader should know when of.
   */
  app.get("/api/agenda", async (c) => {
    const asOf = new Date();
    const fortnight = windowAround(asOf, 14);
    const from = Number(c.req.query("from") ?? fortnight.from);
    const to = Number(c.req.query("to") ?? fortnight.to);

    // A window that is not a window is a 400 rather than a silent full scan.
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return c.json({ error: "from and to are unix seconds, and to comes after from" }, 400);
    }

    // The guild's zone, not the server's and not the reader's: the day a
    // session falls on is a fact about the table, and two people in two zones
    // must not see it on different days.
    const timeZone = await settingOr<string>(
      c.env,
      SETTING_KEYS.timezone,
      SETTING_DEFAULTS[SETTING_KEYS.timezone],
    );

    return c.json(await agendaBetween(c.env, from, to, asOf, timeZone));
  });

  /**
   * The write half. Each route is a thin wrapper over the domain function that
   * does the work — the console is a caller, not a second implementation, which
   * is what keeps "every write lands in audit_log" true rather than hopeful.
   */
  app.post("/api/campaigns", async (c) =>
    refusable(c, async () => {
      const id = await createCampaign(c.env, await c.req.json(), c.get("userId"));
      return c.json({ id }, 201);
    }),
  );

  app.patch("/api/campaigns/:id", async (c) =>
    refusable(c, async () => {
      await updateCampaign(c.env, c.req.param("id"), await c.req.json(), c.get("userId"));
      return c.json({ ok: true });
    }),
  );

  /**
   * One session, for the rail beside the agenda. Read-only, and it calls nothing
   * outward: the links are URLs assembled from ids and the sync state is what
   * `calendar_links` says.
   */
  app.get("/api/sessions/:id", async (c) => {
    const detail = await sessionDetail(c.env, c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "Orrey does not know that session." }, 404);
  });

  /**
   * One campaign's plan: where it is, where it may go, what it runs on, who is
   * on it, and what is coming.
   *
   * `asOf` is returned with the answer rather than left implicit, the same
   * envelope the agenda uses. The page is a reading, and the reader should know
   * when of.
   */
  app.get("/api/campaigns/:id/page", async (c) => {
    const asOf = new Date();
    const page = await campaignPage(c.env, c.req.param("id"), asOf);
    return page
      ? c.json({ asOf: Math.floor(asOf.getTime() / 1000), campaign: page })
      : c.json({ error: "Orrey does not know that campaign." }, 404);
  });

  /**
   * One campaign's record: what it has played, and the flake memory counted from
   * exactly those rows.
   *
   * A second route rather than more of `/page`, because it is a different query
   * with a different failure mode — and because a page that has to hold the plan
   * and the record at once is a page where neither is legible.
   */
  app.get("/api/campaigns/:id/history", async (c) =>
    c.json(await campaignHistory(c.env, c.req.param("id"))),
  );

  app.get("/api/campaigns/:id/roster", async (c) =>
    c.json({ roster: await rosterRows(c.env, c.req.param("id")) }),
  );

  app.put("/api/campaigns/:id/members", async (c) =>
    refusable(c, async () => {
      await putMember(c.env, c.req.param("id"), await c.req.json(), c.get("userId"));
      return c.json({ ok: true });
    }),
  );

  app.delete("/api/campaigns/:id/members/:userId", async (c) =>
    refusable(c, async () => {
      await removeMember(c.env, c.req.param("id"), c.req.param("userId"), c.get("userId"));
      return c.json({ ok: true });
    }),
  );

  app.put("/api/games/:id?", async (c) =>
    refusable(c, async () => {
      const id = await putGame(c.env, c.req.param("id"), await c.req.json(), c.get("userId"));
      return c.json({ id });
    }),
  );

  /**
   * Opening a date poll for the whole server.
   *
   * A console page rather than a fifth command, which is the rule this phase
   * keeps testing: if opening a poll seems to want its own command, that is the
   * console needing a page — and this is the page. It sits behind the same
   * `/api/*` gate as everything else here, so an unauthenticated post is a 401
   * before it reaches any of this.
   */
  app.post("/api/polls", async (c) =>
    refusable(c, async () => {
      const result = await openPollFromConsole(c.env, await c.req.json(), c.get("userId"));
      return result.ok
        ? c.json({ id: result.pollId }, 201)
        : c.json({ error: result.error }, result.status);
    }),
  );

  /**
   * Opening seating on a day, locking it, calling it off.
   *
   * A console page rather than a fifth command — the rule the phase keeps
   * testing. Opening seating is the one that does real work: it mints the day's
   * session and arms the jobs that put it on a calendar, and `transition` is
   * where all of that lives. This route reads a state and hands over.
   */
  app.post("/api/game-days/:id/transition", async (c) =>
    refusable(c, async () => {
      const { to } = (await c.req.json()) as { to?: GameDayState };
      if (!to) return c.json({ error: "which state?" }, 400);

      try {
        return c.json(await transitionGameDay(c.env, c.req.param("id"), to, c.get("userId")));
      } catch (error) {
        // An illegal move is the domain saying no to what was asked — a sentence
        // meant to be read, not a failure to log.
        if (error instanceof IllegalDayTransition) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }),
  );

  app.post("/api/campaigns/:id/transition", async (c) =>
    refusable(c, async () => {
      const { to } = (await c.req.json()) as { to?: CampaignState };
      if (!to) return c.json({ error: "which state?" }, 400);

      const result = await transition(c.env, c.req.param("id"), to, c.get("userId"));
      return c.json(result);
    }),
  );

  /** Logging out is forgetting the cookie. The token pair is dropped with it. */
  app.post("/console/logout", (c) => {
    c.header("set-cookie", clear(SESSION_COOKIE));
    return c.redirect("/", 302);
  });

  // Per-campaign ICS feeds. Calendar clients cannot do OAuth, so the token in
  // the path is the only credential — it must be unguessable.
  app.get("/ics/:token.ics", (c) => c.text("Not implemented until phase 6.", 501));

  /**
   * Discord's terms require a stated privacy policy and a delete-my-data path.
   * The policy is a page; the delete path is a button on `/console`, because
   * Discord is the only identity Orrey has — an unauthenticated HTTP DELETE
   * would be a way to erase someone else's data.
   */
  app.get("/privacy", (c) => c.env.ASSETS.fetch(new Request(new URL("/privacy.html", c.req.url), c.req.raw)));
  app.delete("/me", (c) =>
    c.json({ error: "Run /console in Discord and choose “Delete my data”." }, 405),
  );

  // Console SPA and anything else static.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}

/**
 * A refused write is a sentence, not a stack trace. `InvalidCampaign` and
 * `IllegalTransition` are both the domain saying no to something a person asked
 * for, so they are 400s carrying the reason — anything else is a fault and stays
 * a 500, because a bug dressed up as a polite refusal is a bug nobody finds.
 */
async function refusable(
  c: { json: (body: unknown, status?: 200 | 201 | 400) => Response },
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof InvalidCampaign ||
      error instanceof IllegalTransition ||
      error instanceof InvalidGame
    ) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
}
