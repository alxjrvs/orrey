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

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

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
  app.get("/console/login", (c) => {
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
