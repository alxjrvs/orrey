---
name: cutover
description: Phase 0 in one sitting — capture the guild's ids, deploy the Worker, repoint the Interactions Endpoint URL from the hermuz Worker to orrey, retire Hermuz, run the smoke test. Use when doing or resuming any of issues #10–#14; the order is load-bearing.
---

# Phase 0 cutover

Everything below is ordered. Read the whole thing before starting.

**Where Hermuz actually is.** Not on Render any more. It runs as the Cloudflare
Worker `hermuz` in this same account: `POST /interactions` with Ed25519
verification, a per-minute cron draining a `jobs` table, and a D1 named
`hermuz` whose tables are all empty. So the Discord application already has an
Interactions Endpoint URL saved, pointing at `hermuz.<account>.workers.dev`.
The cutover is repointing it. Reversible by pointing it back — but Hermuz's cron
is a separate thing to stop, or it keeps posting reminders after it goes deaf.

Secrets never appear on stdout. Every command that needs one runs under
`op run --env-file=.env.op --` (copy `.env.op.example` and point it at the vault).

## 0. Preconditions

- The whole phase-0 PR stack is merged to `main`; `npm test` is green.
- `wrangler login` done in an interactive terminal (or `CLOUDFLARE_API_TOKEN` set).
- `.env.op` exists and `op run --env-file=.env.op -- env | grep -c DISCORD_` prints `5`.
- The D1 `orrey` exists (`6d2002e5-…` in `wrangler.jsonc`).

## 1. The ids — #10

There is nothing to copy. Hermuz's D1 has no rows, so the ids come from Discord:

```bash
mkdir -p ops
op run --env-file=.env.op -- node --experimental-strip-types scripts/adopt-ids.ts --json ops/adopted-ids.json
```

Read the listing. Decide which role + channel is each of the four campaigns and
which text channel is the scheduling channel — that mapping is yours, and phase
2 (#26) enters it by hand. Note every scheduled event marked `ours`: Orrey
inherits authorship of those, so `CREATE_EVENTS` suffices.

Then freeze the repo it is read from as a specification:

```bash
gh repo archive alxjrvs/Hermuz --yes
```

## 2. Google — #11

Separate sitting, no Discord dependency. Follow the header of
`scripts/prove-gcal.ts` and record the outcome on #11. If it fails, phase 1 does
not start until a fallback is chosen.

## 3. Deploy — #12

```bash
npm run db:migrate:remote                       # users, settings, jobs
npx wrangler queues create orrey-outbox
npx wrangler queues create orrey-outbox-dlq
for s in DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN DISCORD_CLIENT_SECRET; do
  op run --env-file=.env.op -- sh -c "printenv $s | npx wrangler secret put $s"
done
npm run deploy
```

Then, with the printed `*.workers.dev` origin:

```bash
node --experimental-strip-types scripts/verify-endpoint.ts https://orrey.<account>.workers.dev
```

All four lines must say `ok`. The 401 on a bad signature is what Discord probes
for. PING → PONG cannot be checked from outside (only Discord holds the private
key); it is covered in `test/interactions.test.ts` and by Discord's own check on
save.

Confirm in the dashboard: four cron triggers, two Durable Object classes
(`GuildGovernor`, `SessionLock`), the queue consumer bound.

## 4. Cutover — #13

One sitting, in this order.

**a. Stop Hermuz's clock.** Cloudflare dashboard → Workers → `hermuz` →
Settings → Triggers → delete the cron trigger. From here Hermuz only does what a
click tells it to, and step b takes the clicks away. (Do not delete the Worker
yet — it is the fallback until the smoke test passes.)

**b. Repoint the Interactions Endpoint URL.** Developer Portal → the
application → General Information → Interactions Endpoint URL → change
`https://hermuz.<account>.workers.dev/interactions` to
`https://orrey.<account>.workers.dev/interactions` → Save. Discord validates: a
PING it expects PONG for, and a bad signature it expects 401 for. If Save is
refused, the Worker is not verifying — go back to step 3. From the moment it
saves, every click and command in the guild lands on Orrey.

**c. Drop the privileged intents, if any are still on.** Same application →
Bot → Presence, Server Members, Message Content all off. Neither Worker has a
gateway; the toggles are leftovers from the Render era.

**d. Overwrite the guild commands with Orrey's four.**

```bash
op run --env-file=.env.op -- npm run commands:register
```

PUT replaces the set. `/task`, `/meal`, etc. cease to exist here.

**e. Neutralise Hermuz's old posts** — the one sanctioned message edit.

```bash
op run --env-file=.env.op -- node --experimental-strip-types scripts/strip-components.ts \
  --scan <scheduling-channel-id> <campaign-channel-id> ...
```

Read the dry-run list. Then re-run with `--apply`. Afterwards click an old
Hermuz button if one survived: it must answer "this post is retired", never
"interaction failed".

**f. Rotate the bot token and client secret.** Portal → Bot → Reset Token;
OAuth2 → Reset Secret. Store both in 1Password, then:

```bash
for s in DISCORD_BOT_TOKEN DISCORD_CLIENT_SECRET; do
  op run --env-file=.env.op -- sh -c "printenv $s | npx wrangler secret put $s"
done
```

This is also what makes step a permanent: the `hermuz` Worker's stored token
stops working.

**g. Seed settings.**

```bash
op run --env-file=.env.op -- node --experimental-strip-types scripts/adopt-ids.ts \
  --sql --scheduling-channel <id> --timezone America/New_York > ops/seed.sql
npx wrangler d1 execute orrey --remote --file ops/seed.sql
```

**h. Link the privacy policy.** Portal → General Information → Privacy Policy
URL → `https://orrey.<account>.workers.dev/privacy`. Closes the last box on #15.

## 5. Smoke test — #14

```bash
op run --env-file=.env.op -- node --experimental-strip-types scripts/smoke-post.ts <scheduling-channel-id>
```

1. Click **Ping**. The message rewrites itself with `1 click, last by <you>` and
   an as-of line. That is a verified interaction → `SessionLock` → D1 → `UPDATE_MESSAGE`.
2. Confirm the row: `npx wrangler d1 execute orrey --remote --command "select * from settings where key like 'smoke:%'"`
   and `… "select discord_id, username from users"`.
3. Wait 15+ minutes. Click again. It must rewrite again — the token lifetime is moot.
4. Click a Hermuz-era button if any survived step 4e: "this post is retired".
5. Have two people click within a second of each other: the tally must reach
   the right number with no repeat readings. That is the lock.

Then close #10–#14 with what you saw, and delete the smoke post if you like — it
is an ordinary message.

## 6. Retire the hermuz Worker

Only after step 5 passes. `npx wrangler delete --name hermuz`, and delete the
`hermuz` D1 from the dashboard (it is empty). The repo stays, archived.

## If something goes wrong after 4b

Point the Interactions Endpoint URL back at `hermuz.<account>.workers.dev` and
re-add its cron — that is the whole rollback, as long as step f has not run
yet. After f, fix forward: the Worker is stateless apart from D1, and
`npm run deploy` of a fix is seconds.
