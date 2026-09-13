# The Orrey — Build Plan (rev 5, 13 Sept 2026)

**Status: planning only. No implementation has started.** Agreed real-world action, not yet done: archive the Hermuz repo read-only (keep a copy of its SQLite file as a Discord-id lookup, not for import).

## All settled decisions

**Shape**
- Source of truth: Orrey's own database. Discord + Google Calendar are displays.
- Stack: TypeScript on Cloudflare Workers, **built fresh**. Hermuz archived read-only, read as a specification, not ported.
- **Repurpose the existing Hermuz Discord application** rather than registering a new one.
- **One repo, one Worker**, schema + repositories in their own package.
- **No database import.** Fresh tables; four campaigns entered by hand; adopt only the existing Discord guild/role/channel ids.

**Discord surface**
- **Discord is the only identity system** — `identify` scope alone; roles read with the bot token; never request `guilds`.
- **Messages are send-only.** Orrey never edits a post it already sent. The one exception: **a click may rewrite the message it came from**, as that interaction's own response. No cron, projector or console action ever touches a posted message.
- **A small command surface** — four read-or-initiate commands, all answering ephemerally: `/upcoming`, `/reschedule`, `/whos-in`, `/console`. Administration stays in the console.
- Buttons remain the primary surface; every action sits on the thing it concerns.
- **Native scheduled events: yes**, horizon capped at two upcoming per campaign, treated as disposable.
- **Attendance: auto-assume** from intent at session end; organiser corrects via per-person toggles.

**Model**
- **Three stages** — date-finding, seating, attendance — any of which an event may skip.
- **Two kinds of event:** campaign session, one-off. Explicit `kind` column.
- **Two kinds of game day:** `single` (one long game — TI, Arcs; capacity from the game) and `multi` (a hangout, **seated at the day level**, tables recorded afterwards).
- **Signups attach to campaigns at formation and to game days — never to a campaign session or individual session.** CHECK constraint.
- Started campaigns skip stages 1 and 2 structurally.

**Date polls**
- **One mechanism, two uses:** no target = pre-signup minting game days from winning dates; with a target = reschedule that moves that session.
- **Players propose, GM confirms and triggers.** Via the attendance post's *Suggest another day* button or `/reschedule`. Max one open poll per session.
- **"Winning" is contextual and the organiser's call.** Default threshold from the game's min player count; alternatives quorum-of-roster, best-available, organiser-picks; override always available.
- **One poll may produce several game days.**
- **Auto-resolve is per-campaign opt-in**, never onto a date the GM hasn't marked available.

**Google Calendar**
- **Service-account auth:** Orrey-owned calendar, service account granted `writer` via `acl.insert`. No refresh token = nothing to expire. Community-established, not documented — **prove in phase 0**.
- **One Orrey calendar** as sync spine; selective subscription via Orrey's own per-campaign ICS feeds from D1.
- **Social calendar is never written to.**

## Send-only messages — what it costs and buys

The things that must stay current are exactly the things driven by clicks, so this is cheaper than it sounds: a tally only changes when someone votes, and that vote is the interaction that re-renders it. Quorum included — the click that crosses the threshold renders the confirmed state.

**Three simplifications:**
1. **The 15-minute interaction token stops mattering.** Previously a post living for weeks needed channel-endpoint edits. Now every rewrite responds to a *fresh* interaction with a valid token; the channel edit endpoint is never called.
2. **Message rate limits stop being a design concern** — edits were the one route where a sync loop could pile up against an undocumented per-channel limit.
3. **Discord projection narrows to scheduled events.** Messages are fire-and-forget: record the id, never reconcile. Only events keep a fingerprint.

**One cost: posts are snapshots and go stale.** Three mitigations, designed in from the start:
- Every post carries an **as-of line**, so it reads as a record not a live view.
- Every post carries a **Refresh** button — an interaction, therefore allowed, turning a stale snapshot current on demand.
- Anything changing from outside (session moved, jeopardy at T-24h, waitlist promotion) **posts a new notice** rather than mutating an old message. Time-triggered state changes were the only real casualty.

Posts accumulate (~26 attendance posts a year per campaign, plus notices), so **a thread per session**: attendance, reminders, reschedule notices and the recap all live there, keeping the campaign channel a short list of threads.

## Three surfaces, three jobs

- **Commands** read and initiate; answer ephemerally or post something new; never edit an existing message. Endpoint handles `APPLICATION_COMMAND`, `APPLICATION_COMMAND_AUTOCOMPLETE` (needed so `/reschedule` can name an event), `MESSAGE_COMPONENT`, `MODAL_SUBMIT`.
- **Buttons** respond, and may rewrite their own message.
- **Console** administers — creating campaigns, cadence, rosters. Form-shaped work a slash command models badly, and keeping it out of Discord is what holds the command list to four.

Commands: `/upcoming` (ephemeral agenda across everything — replaces the idea of a pinned board; always current, no channel noise), `/reschedule` (autocomplete an upcoming event → opens a date poll), `/whos-in` (authoritative roster state when a post has gone stale), `/console` (ephemeral login link).

Buttons: attendance post = In / Out / Maybe / Note + *Suggest another day* + *Refresh*; signup post = Take a seat / Waitlist / Out + *Can't make this one — suggest a day*; date poll = multi-select + organiser-only *Canonise*; post-session correction = toggle per person.

## Three premises

1. **Orrey is a reconciler, not a replicator** (for events and Google; messages are send-only and never reconciled).
2. **There are three questions, not one.** "Which day?", "who's in?", "still coming?" — consecutive stages, different audiences, any may be skipped.
3. **Discord is identity.**

Central question is **"does it run"** — quorum, not just calendar. When the answer is no, the response is a date poll, not a cancellation.

## The three stages

1. **Date-finding** (pre-signup). Poll of candidate dates; winners *become* game days. Audience: whole server.
2. **Seating.** Day exists and is announced; people claim a place. Capacity and waitlist. Audience: whole server.
3. **Attendance.** Still coming, and afterwards, did you come? Audience: roster only.

| Event | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| New campaign | optional (find the slot) | Join the campaign | In? every session |
| Started campaign | skipped | skipped (roster given) | In? every session |
| Single game day | Which Saturday? | Claim 1 of 6 seats | Still in? then who showed |
| Multi game day | Which Saturday? (may win >1) | Coming to the day? | Who showed; tables form on the day |

## Lifecycles

Campaign: `FORMING → RUNNING ⇄ HIATUS → CONCLUDED`. Signup buttons only in FORMING; a closed roster never reopens on its own.

Game day: `PROPOSED → SEATING → LOCKED → PLAYED` (or `CANCELLED`).

Attendance: `intent` (in/out/maybe/null) + `attended` (0/1/null) + `attended_source` (auto/gm).

## Domain model highlights

- `campaigns` — lifecycle, kind (run/play/**tracked**), recurrence_anchor + interval_weeks, quorum, capacity, max_sessions, **first_session_number**, location_type, channel/role/colour
- `game_days` — **kind (single/multi)**, date, venue, title, host, capacity, game_id (set for single)
- `sessions` — **kind (campaign_session/one_off)**, campaign_id *or* game_day_id, number, starts_at/ends_at, location, state
- `signups` — target_type (campaign-forming *or* game_day), target_id, user_id, state, position, character_name
- `attendance` — intent + attended + attended_source + note (+ optional tables-played on multi days)
- `date_polls` — nullable target, game_id, game_day_kind, **win_rule**, win_threshold, status, opened_by, closes_at, channel/message; `poll_dates` (≤10) with **outcome**; `poll_responses`
- `calendar_links` — session_id, deterministic base32hex gcal_event_id, fingerprint, synced_at, last_error
- `users` — discord_id PK, names as cache, feed_token, dm_state
- `jobs`, `games`, `campaign_members`, `session_logs`, `settings`, `audit_log`

## Architecture

One Worker, three entry points: HTTP (interactions + console + ICS), Queue consumer (outbound writes), Cron (the clock). Drizzle carries over — speaks D1 as well as SQLite.

- **Hono on Workers**, console as static assets, same origin. Verify Ed25519 first.
- **D1 + Drizzle.**
- **`jobs` table (D1)** for time-based work — inspectable in a way a queue isn't.
- **Queues** for outbound projection: Google, and Discord **scheduled events** — not messages.
- **Durable Objects** — per guild as rate-limit governor; per session for concurrent clicks.
- **Cron** — minute: drain jobs; hourly: materialise horizon; daily: renew Google watch channels; nightly: full reconcile.
- ICS feeds need an unguessable `feed_token` (calendar clients can't do OAuth).
- **Echo-loop prevention is the app's job** for Google — store a content fingerprint.

## Hermuz: what it proved

~14,500 lines of working TypeScript, last commit 2026-08-20, bot presence already "the Orrery of Worlds." Not an early attempt.

**Carry over (as ideas):** `users.discord_id` as PK; **recurrence as anchor + interval_weeks**, anchor possibly in the past; campaign sessions and one-offs in one table; durable idempotent `jobs` table; inherited location type (maps to Discord `EXTERNAL` vs `VOICE`); single-guild + `settings` key/value. Later: task templates, meal polls.

**Leave behind:** discord.js gateway + privileged intents; SQLite on a Render disk with `numInstances: 1`; separate Netlify SPA + CORS.

**Generalize:** its `surveys` already does candidate dates → canonize → game day → carry available players over. Becomes `date_polls` with nullable target and per-date outcomes.

**Absent entirely:** Google Calendar sync.

### The cutover

Reusing the app inherits guild permissions and **authorship of the scheduled events and roles Hermuz created** (so `CREATE_EVENTS` suffices). But:

- **Setting an Interactions Endpoint URL stops Discord delivering interactions over the gateway** — Hermuz's bot goes deaf the moment it's saved. No overlap period.
- Circular: Discord validates the endpoint on save (including with a bad signature it expects a 401 for), so **the Worker must be deployed and verifying first.**
- Drop the two privileged intents.
- **Bulk-overwrite the command set** with Orrey's four, which is what makes `/task`, `/meal` etc. cease to exist.
- **Neutralise old interactive posts** — Hermuz `custom_id`s are unknown to Orrey; an unhandled click shows "interaction failed". Strip components at cutover + catch-all "this post is retired" handler.
- Rotate bot token and client secret.

### Fresh data, adopted ids

No import. Enter four campaigns by hand. Carry across only the **Discord ids** — guild, per-campaign roles and channels, scheduling channel, live scheduled events — so Orrey takes over existing objects rather than creating a parallel set. Keep the Hermuz SQLite copy purely as the id lookup during setup.

Two honest costs: session numbers need seeding (hence `first_session_number`), and history starts empty so flake-memory/stats say nothing for a couple of months.

## Platform constraints (verified, Sept 2026)

1. **Discord can't own recurrence** — weekly = exactly one weekday; `count`/`end` cannot be set externally.
2. **Discord has no yes/no/maybe** — event user list has no response field.
3. **Google `syncToken` is incompatible with `timeMin`, `q`, `privateExtendedProperty`** — hence our own calendar.

Also: no gateway needed; Discord statuses `COMPLETED`/`CANCELED` are terminal and auto-fire, so **moving a lapsed session means minting a new Discord event**; 100 events/guild; **interaction token lifetime is moot** under send-only; 5 buttons/row so a 10-date poll needs a multi-select; Discord OAuth access tokens ~7 days with **rotating** refresh tokens; bot DMs can't be pre-checked — error `50007` is how you learn, treat as permanent, fall back to channel mention; Google upsert = own base32hex id, `insert` then `409` → `update`; `events.watch` carries **no body**, 7-day TTL, no auto-renew, not 100% reliable; Google attendee `responseStatus` doesn't RSVP for anyone; public ICS refresh ~8–24h in Google; Discord terms require a privacy policy and a delete-my-data path.

## Roadmap (ordered by risk retired)

- **Phase 0 — Footings.** *In order:* copy Hermuz's SQLite as an id lookup, note the ids, archive the repo. Prove the service-account calendar pattern by hand. Stand up Worker/Hono/D1/Drizzle and **deploy with working Ed25519**. Only then save the Interactions Endpoint URL = the cutover (drop intents, overwrite commands, neutralise old posts, rotate secrets). Smoke test: a posted message whose button click round-trips to D1 and rewrites that message as its interaction response. Ship delete-my-data now.
- **Phase 1 — One session, three surfaces.** One hardcoded running campaign → Discord event + attendance post + Google event; buttons rewrite their own message; projector idempotent. *Use it for a real Age of Umbra session before continuing.*
- **Phase 2 — Lifecycle and cadence.** Campaigns/games/roster, full lifecycle, anchor+interval recurrence, horizon materialiser, **plus a minimal console with Discord login**. Enter the four campaigns pointed at their existing Discord ids.
- **Phase 3 — Does it run.** Quorum auto-confirm, jeopardy notices, reminder ladder with DM fallback, attendance auto-assume + correction, flake memory, per-session threads, `/upcoming`.
- **Phase 4 — Date polls, both uses.** Target → move a session. No target → pre-signup minting game days with a win rule. This *is* availability polling.
- **Phase 5 — Game days.** Single (capacity from game, waitlist auto-promotion) and multi (day-level seating, tables recorded after).
- **Phase 6 — The console, properly.** Agenda/month views, campaign pages, ICS feeds.
- **Phase 7 — Logs, memory, and the echo.** Threads, recaps, history, stats; then the Google return path. Last because it's the only loopable edge.

## Open (non-blocking, before phase 5)

On a multi game day, should attendance record *which* tables someone played? Leaning yes — optional field, filled by whoever runs the day rather than per player.

## Flagged as unverified

Service-account-shared-calendar pattern; max TTL for `events.watch`; whether Discord's token endpoints accept PKCE (undocumented, unnecessary for a confidential client); whether repeated `privateExtendedProperty` filters are AND or OR (Google's reference and guide contradict each other).
