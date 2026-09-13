import { Hono } from "hono";
import type { Env } from "../env.ts";
import { verifyDiscordRequest } from "../discord/verify.ts";
import { handleInteraction } from "../discord/interactions.ts";
import type { Interaction } from "../discord/types.ts";

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

    const response = await handleInteraction(JSON.parse(body) as Interaction, c.env);
    return c.json(response);
  });

  // Per-campaign ICS feeds. Calendar clients cannot do OAuth, so the token in
  // the path is the only credential — it must be unguessable.
  app.get("/ics/:token.ics", (c) => c.text("Not implemented until phase 6.", 501));

  // Discord's terms require a stated privacy policy and a delete-my-data path.
  app.get("/privacy", (c) => c.env.ASSETS.fetch(c.req.raw));
  app.delete("/me", (c) => c.text("Not implemented.", 501));

  // Console SPA and anything else static.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
