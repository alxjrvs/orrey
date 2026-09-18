# Phase 2 as a stack

The plan for cutting [#4](https://github.com/alxjrvs/orrey/issues/4) — issues
#21–#26, plus #73 — as fifteen stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 2 is the first phase that gives people a way to *remove* things — the
lifecycle concludes campaigns, the console edits them, the materialiser makes
sessions in bulk. So the stack does not open with the domain schema. It opens
with #73, the four phase-1 findings that all say the same thing: a published
object's id can be lost while the object stays up. None of them can bite while
sessions are seeded by hand and never deleted; all of them are reachable the
moment #22 and #25 exist. Settling that first means everything above it inherits
the rule rather than having it retrofitted.

After that the line is the obvious one — schema, then the lifecycle that reads
it, then the recurrence that produces sessions from it. The console does not
need the materialiser: it writes cadence columns and calls lifecycle functions,
and the hourly tick picks up whatever it leaves behind. So `p2/10-console-login`
**forks** off `p2/6-roster` and the two halves of the phase — the clock and the
console — are in review at the same time, the way `p1/8-gcal` forked off the
outbox.

```
main
 └── p2/1-published (#73)
      └── p2/2-adopt-retract (#73)
           └── p2/3-games (#21)
                └── p2/4-roster-schema (#21)
                     └── p2/5-lifecycle (#22)
                          └── p2/6-roster (#22)
                               ├── p2/7-recurrence (#23)
                               │    └── p2/8-materialiser (#23)
                               │         └── p2/9-event-cap (#23)
                               └── p2/10-console-login (#24)
                                    └── p2/11-console-gate (#24)
                                         └── p2/12-console-command (#24)
                                              └── p2/13-console-shell (#25)
                                                   └── p2/14-console-campaign (#25)
                                                        └── p2/15-console-roster-games (#25)
```

## The slices

### 1. `p2/1-published` — the ledger of what Orrey put in the world · #73

The decision #73 asks for, in the only form that settles it: a ledger of what
Orrey has put into the world, keyed to the target id as a plain string and
**holding no foreign key to `sessions`**. That absence is the whole point.
`ON DELETE cascade` on `calendar_links` destroys the only record that a Google
event exists out there; a table that cascades cannot be the record of something
that does not.

`src/db/schema.ts` gains `publications` — `id` (`<surface>:<kind>:<target_id>`),
`surface`, `kind`, `target_id`, `remote_id` (null while claimed), `state`
(`claimed` | `published` | `retracted`), `claimed_at`, `published_at`,
`retracted_at`, `last_error` — plus the generated migration.
`src/projection/publications.ts` holds `claim`, `record`, `find` and `retract`.

Then the create paths use it. `src/attendance/post.ts` claims before it posts:
the insert of the claim row is the guard, not the recorded `discord_message_id`,
so a crash between `postMessage` returning and the id reaching D1 leaves a claim
that says "someone is already posting this" rather than a second post with live
buttons. Under send-only a duplicate cannot be tidied away, so the failure this
prefers is **no post at all** — a missing post is something a human can re-arm;
two posts is not. `src/google/calendar.ts` and `src/discord/events.ts` record on
success; neither changes behaviour yet.

*Tests*: a post whose id write fails does not post twice on the next drain; a
`publications` row survives deleting its session row, where `calendar_links`
does not; `claim` twice returns the existing claim rather than throwing; the
ledger id is derived, so two claims for the same session collide by
construction.

*Review focus*: no foreign key, no cascade, no `references()` on `target_id` —
and a comment saying why, because the next person to tidy the schema will want
to add one. `publications` is not user-keyed, so `src/privacy/delete.ts` is
correctly untouched.

### 2. `p2/2-adopt-retract` — look before creating, retract without the row · closes #73

The other two findings. Discord has no derived id the way Google does, so it
gets the same thing by a different route: `scheduledEventBody` in
`src/discord/events.ts` writes a marker into the event's `description`, and
`upsert` with no `discord_event_id` first lists the guild's scheduled events
through the governor and adopts one carrying this session's marker. The scan is
bounded by the 100-events-per-guild cap, which is the same cap that makes it
cheap.

And the delete path stops needing the row. `project` in
`src/queue/consumer.ts` currently returns on a missing target — but delete is
precisely the case where the row is disappearing, so that is the common path,
not the rare one. A `*.delete` for an unknown session now reads `publications`
for that target id and retracts what is listed there.

The marker changes `discordProjectedContent`, so every live event is rewritten
once on the first upsert after this lands. That is four PATCHes, stated rather
than hidden.

This also does half of #26's work early: an existing Hermuz-authored event can
be attached to a session by writing its id into `publications`, and the
projector adopts instead of duplicating.

*Tests*: create-then-crash, re-run, and exactly one event exists; a
`discord.event.delete` for a session row that is already gone still issues the
DELETE with the stored id; a retracted row is not adopted back; an event
carrying another session's marker is not adopted.

*Review focus*: the scan goes through `GuildGovernor` like every other Discord
call, and the marker is constant per session so the fingerprint moves exactly
once. Nothing here reads state out of a Discord *message* — the adoption is of
scheduled events only.

### 3. `p2/3-games` — games, and the columns a campaign needs to recur · #21

`games` — name, min/max players, default duration in minutes — and the columns
`campaigns` is missing: `game_id`, `recurrence_anchor`, `interval_weeks`,
`quorum`, `capacity`, `max_sessions`, `first_session_number`.
`src/db/schema.ts` plus the generated migration — seven `ALTER TABLE ADD COLUMN`
and one `CREATE TABLE`, and **not** a table rebuild.

This is where the plan met reality (`p2/3` is #77). The first version put a CHECK
on `interval_weeks`, which made drizzle-kit rebuild `campaigns`: `PRAGMA
foreign_keys=OFF`, copy, `DROP TABLE campaigns`, rename. In D1 that PRAGMA does
nothing, so the drop fires `ON DELETE CASCADE` on everything referencing the
table — the migration would have deleted every session, and `attendance` and
`calendar_links` behind them, and reported success. Proved against the real D1:
parent rebuilt, child went from one row to zero.

So a referenced table grows only by `ALTER TABLE ADD COLUMN`, the interval rule
moves to the code that writes the column (`src/campaigns/recurrence.ts` refuses
it), and `games` keeps its CHECK because it is a new table with nothing pointing
at it. `docs/GOTCHAS.md` carries this and the two other generator traps the stack
turned up. `0003_campaign_state_fails_closed.sql`, already in `main`, has the
same shape and wants checking against a copy of the remote database.

#21's last bullet asks for lifecycle state; `campaigns.state` has carried it
since `p1/1-schema`, defaulting to FORMING so that an insert which forgets to
say fails on the safe side. Nothing to add.

No per-campaign timezone: recurrence is wall-clock work and the zone is one
guild's, already at `SETTING_KEYS.timezone`. `first_session_number` defaults to
1 and exists because history starts empty — the four real campaigns continue
Hermuz's numbering from a number entered by hand.

*Tests*: the migration applies in the workerd pool; an interval of zero is
*accepted*, on purpose, so that if a future migration makes it throw somebody
learns a rebuild crept back in; `games.min_players` may not exceed
`max_players`; deleting a game keeps the campaign and its sessions;
`first_session_number` defaults to 1; and SQLite hands back the string
`not_a_column` for an unresolvable quoted name, which is the behaviour behind
the third generator trap.

*Review focus*: no column phase 2 does not read. `quorum` and `capacity` are
here because #25's campaign form writes and shows them; nothing in phase 2 acts
on either, which is why both are plain integers with no derived state — "does it
run" is phase 3.

### 4. `p2/4-roster-schema` — the roster, the signup, and the audit log · closes #21

`campaign_members` (campaign_id, user_id, role `gm`/`player`, joined_at,
character_name, keyed on the pair), `signups` (target_type, target_id, user_id,
state, position, character_name) and `audit_log` (actor, action, target_type,
target_id, before/after as JSON, created_at).

The CHECK is the one CLAUDE.md names: `target_type IN ('campaign_forming',
'game_day')`. Both values, though phase 2 only writes the first — the constraint
*is* the invariant, and a constraint that has to be widened later is one someone
widens without thinking. There is no `session` value to reject because there is
no way to spell one.

`src/privacy/delete.ts` gains both new user-keyed tables and counts them on the
receipt. That file says every phase adding a user-keyed table adds its delete
here; this is the first phase to owe it.

*Tests*: an insert with `target_type = 'session'` is rejected by the constraint,
not by TypeScript; adding the same member twice is one row; a deletion receipt
for someone on a roster names `campaign_members` and `signups` with real counts.

*Review focus*: the CHECK is in the migration SQL, not only in the Drizzle enum
— the enum is advice, the constraint is the invariant. `audit_log` stores ids
and a JSON diff, never a rendered sentence: what it is for is answering "who
changed this", and a sentence written today is unreadable after the next rename.

### 5. `p2/5-lifecycle` — one transition function, and starting closes the roster · #22

`src/campaigns/lifecycle.ts`: one `transition(env, campaignId, to, actor)`, one
legal-edge map — FORMING → RUNNING, RUNNING ⇄ HIATUS, RUNNING/HIATUS →
CONCLUDED — and an `audit_log` row written in the same D1 batch as the state
change, so there is no way to move a campaign without leaving the record of who
moved it.

RUNNING → FORMING is absent from the map, and that absence is the enforcement of
"a closed roster never reopens on its own". CONCLUDED has no outgoing edges at
all.

Starting a campaign is what closes the roster: FORMING → RUNNING converts
accepted `signups` into `campaign_members` in the same batch.

`signupComponents` and `addSignup` were planned here and are **not** in `p2/5`
(#79). Nothing in phase 2 renders a signup post, so both would have been dead
code with tests pretending otherwise; the guard they were to provide is already
structural, because only FORMING → RUNNING converts and there is no edge back to
FORMING. They arrive with the surface that needs them, in phase 5.

No signup *post* is rendered in phase 2. The four real campaigns are entered as
RUNNING and skip stages 1 and 2 structurally; the forming-signup surface arrives
with game days in phase 5.

*Tests*: every legal edge succeeds and every illegal one throws, CONCLUDED →
RUNNING included; the audit row carries actor, from and to; a failed transition
writes no audit row; starting a campaign with three accepted signups produces
three members and leaves no route back.

*Review focus*: this is the only place `campaigns.state` is updated.
`src/db/seed-sql.ts` inserts `'RUNNING'` and still never writes `state` on
conflict — an insert is not a transition, and the seed's own comment says so.

### 6. `p2/6-roster` — where a roster comes from, and when a campaign stops · closes #22

`src/campaigns/roster.ts`: `rosterOf(env, campaignId)` reads `campaign_members`
for a campaign that has started and accepted `signups` for one that has not.
That is #22's structural claim made real — a campaign entered directly as
RUNNING never had signups and must not be asked for them.

The consumer is the attendance post. `src/attendance/rows.ts` says in as many
words that "who hasn't" arrives with `campaign_members` in phase 2; it now
returns roster members with no intent alongside the people who answered, and
`src/attendance/render.ts` grows the unheard-from line. Nothing else about the
post changes — it is still rendered from D1, still sent once, still never read
back.

And `remainingSessions(campaign, materialisedCount)`: when `max_sessions` is
reached the campaign stops producing sessions. It is **not** concluded
automatically. CONCLUDED is terminal and nothing terminal should be entered by a
cron on a Tuesday morning — so materialisation stops, the console shows nothing
remaining, and concluding stays the organiser's click. The nudge that tells the
GM is a notice post, and notices arrive with phase 3's ladder.

*Tests*: a RUNNING campaign's roster comes from members even when stale signup
rows exist; a FORMING campaign's comes from signups; the attendance post lists a
roster member who has said nothing, under the right heading and never as "out";
`remainingSessions` hits zero exactly at `max_sessions` and a null
`max_sessions` never exhausts.

*Review focus*: the renderer stays a pure function of rows and an as-of time —
the roster arrives as rows, not as a fetch inside the renderer.

### 7. `p2/7-recurrence` — anchor plus interval, with the anchor in the past · #23

`src/campaigns/recurrence.ts`, and nothing else. `occurrencesFrom({ anchor,
intervalWeeks, firstSessionNumber, from, count, timezone, durationMinutes })`
returns `{ number, startsAt, endsAt }[]`: step forward in whole intervals from
the anchor to the first occurrence at or after `from`, and number it
`firstSessionNumber` plus the steps taken. The anchor is usually in the past —
that is the point of carrying it over from Hermuz, and it is what makes "session
47" arithmetic rather than a counter someone has to maintain.

The trap worth the test: adding weeks in unix seconds moves the wall-clock hour
across a DST boundary, so a fortnightly 19:00 game becomes an 18:00 game in
November. The step is taken in the guild's zone and converted back, and the zone
arrives as an argument.

*Tests*: an anchor two years back yields the next occurrence at 19:00 local, not
19:00 UTC; the number increments once per interval and not once per returned
item, so skipping the past does not renumber the future; a fortnightly series
across the March and November changes keeps its wall-clock time; an occurrence
that has already started is skipped; `count` is honoured exactly.

*Review focus*: purity. No `Date.now()`, no `Env`, no D1 — `from` and `timezone`
are arguments, which is what lets the materialiser above be tested at a fixed
instant. A new entry in `docs/GOTCHAS.md` for the DST step belongs with this PR.

### 8. `p2/8-materialiser` — sessions to the horizon, made once · #23

`src/campaigns/materialise.ts` and the `horizon` case in
`src/cron/scheduled.ts`, which has been an empty case with a comment since the
clock PR. For every RUNNING campaign with an anchor and an interval: compute the
occurrences out to the horizon, insert the ones that are missing, and arm their
jobs. HIATUS and CONCLUDED campaigns are simply not in the select — which is all
"HIATUS pauses materialisation, RUNNING resumes from the anchor" needs to mean,
because the anchor never moved.

Idempotency is the session id, not a flag: `${campaignId}-s${number}`, the same
identity rule `src/db/seed-sql.ts` already argues for. Re-running the tick
inserts nothing twice because the second insert conflicts on the primary key.

The attendance post becomes a `jobs` row at the lead time rather than a post at
materialisation — `session.post-attendance` with `run_at` of `starts_at` minus
`SETTING_KEYS.attendanceLeadDays` rather than `unixepoch()`. `drainJobs` needs
no new kind: both job kinds already exist. Horizon size lands in `settings` too,
with the default written down next to the key.

*Tests*: two ticks in a row produce the same rows; a HIATUS campaign produces
none; a campaign with no anchor is skipped rather than throwing and stopping the
loop; the post job's `run_at` is the lead time before the start, not now; a
session that already exists is left alone.

*Review focus*: the materialiser **inserts and never updates**. A session whose
`starts_at` has moved was moved by a human or by phase 4's date poll, and a
materialiser that overwrites it would undo that every hour. `ON CONFLICT DO
NOTHING`, not `DO UPDATE`.

### 9. `p2/9-event-cap` — two upcoming Discord events, and the third comes down · closes #23

Discord allows 100 scheduled events per guild and Orrey treats them as
disposable, so the horizon on that surface is two upcoming per campaign while D1
and Google run as far ahead as the settings say. `enqueueProjection` already
takes a surface list, so this is the caller's job: after materialising, the
nearest two upcoming sessions of a campaign are enqueued for both surfaces, the
rest for `google` only, and any session past the second that still holds a
`discord_event_id` is enqueued for `discord.event.delete`.

That retraction goes through the ledger from `p2/1`, so taking an event down
does not lose the record that it was up. Four campaigns times two is eight
events, against a cap of a hundred — the headroom is deliberate, because phase 4
mints a *replacement* event whenever a lapsed session moves.

*Tests*: three upcoming sessions produce two Discord upserts and one
Google-only; the third, holding an event id, produces a delete; a past session
holding an event is left alone, because the cap counts upcoming only; the
retraction is recorded in `publications`.

*Review focus*: the cap is per campaign and counted from now, not a global limit
that a busy campaign could eat. Nothing here touches a message — the attendance
post for a session beyond the cap still goes out on its job, because the post is
not the event.

### 10. `p2/10-console-login` — Discord OAuth with identify and nothing else · #24 · forks off slice 6

Forks off `p2/6-roster`: the console writes cadence columns and calls lifecycle
functions, and never needs the materialiser — the hourly tick picks up whatever
the console leaves behind. So this whole line reviews in parallel with
`p2/7`–`p2/9`.

`src/console/oauth.ts` and the two routes in `src/http/app.ts`. `GET
/console/login` redirects to Discord's authorize endpoint with
`response_type=code`, **`scope=identify`**, and a `state` value also set as a
short-lived cookie. `GET /console/callback` checks `state` before it exchanges
anything, exchanges the code with `DISCORD_CLIENT_SECRET`, reads `/users/@me`
with the user's token, upserts through `src/db/users.ts`, stores the token pair,
and sets the session cookie — `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
signed with `CONSOLE_SESSION_SECRET`, which is already in `src/env.ts` waiting
for this.

The token pair needs a home: a `discord_tokens` table keyed by discord id —
access token, refresh token, expiry. It is user-keyed, so `src/privacy/delete.ts`
gains it and the receipt counts it.

No PKCE. Discord is a confidential client here and whether its token endpoint
accepts a verifier is undocumented; relying on an undocumented acceptance is how
a login breaks silently.

*Tests*: the authorize URL carries `identify` and no other scope, and the string
`guilds` appears nowhere in the request; a callback whose `state` does not match
the cookie is refused without the code ever being exchanged; the cookie carries
all four attributes; the deletion receipt counts the token row.

*Review focus*: `identify` only — the invariant is that roles never come from
the user's token, and the cheapest way to guarantee it is never to have asked
for them.

### 11. `p2/11-console-gate` — the rotating pair, the bot-token role read, and the gate · #24

`src/console/session.ts` reads the cookie back to a user and refreshes the
access token when it is near expiry. Discord rotates refresh tokens, so a
refresh replaces **both** halves — keeping the old refresh token is how someone
ends up logged out permanently a week later — and a refresh that fails deletes
the pair and reads as logged out rather than as an error.

`src/console/roles.ts` reads the member with the **bot** token — `GET
/guilds/{guild}/members/{user}` through the governor — and compares against an
organiser role id in `settings`. `requireOrganiser` is the middleware every
console route behind this sits under; it answers 403, not a redirect, because
the caller is `fetch` from the SPA.

*Tests*: a refresh stores the new refresh token and the old one is gone; a 400
from the token endpoint logs the user out and returns no session rather than
throwing; a member without the role gets 403; the member request carries `Bot
<token>` and never the user's bearer token; an unseeded organiser role id fails
closed.

*Review focus*: Discord is the only identity system, and this is the file where
that could quietly stop being true. Roles from the bot token, membership from
the guild endpoint, nothing inferred from the user's own token.

### 12. `p2/12-console-command` — a short-lived link, and the way out stays · closes #24

`console_` in `src/discord/interactions.ts` stops apologising for phase 2 and
answers with a login link: a signed, single-use, five-minute token on
`/console/login`, so the click that reaches the browser is one that came from
Discord just now.

The part that is easy to lose: today that same ephemeral response carries the
**Delete my data** button, and Discord's developer terms require that path to
exist. It stays exactly where it is, alongside the link, until the console has a
page of its own for it — which is phase 6, not this phase.

*Tests*: the link's token verifies and an expired one answers with a plain
sentence rather than a 500; the response is still ephemeral; the privacy button
is still present and still walks the confirm/cancel path from `p1`'s tests; an
already-used token is refused.

*Review focus*: the command surface is still four commands — this changes what
`/console` answers, not how many commands exist. And `src/discord/commands.ts`
is untouched, which is the evidence.

### 13. `p2/13-console-shell` — the shell and the campaign list · #25

The read half, so the write half reviews on its own. `public/console/` —
`index.html`, one ES module, and the tokens from `design/tokens/*.css` vendored
in, because `public/` is what the `ASSETS` binding serves and `design/` is not
shipped. **No bundler.** The repo has no build step and this is not the phase to
add one, so the design system's React components under `design/ui_kits/console`
are the reference for how it looks, not a dependency. The cost is hand-written
markup; the saving is that `npm run deploy` stays one command.

`src/console/api.ts` mounts under `requireOrganiser` with the read routes: `GET
/api/me`, `GET /api/campaigns` (with state, cadence and member counts), `GET
/api/games`. Chrome, sidebar and the campaign list, as laid out in
`design/ui_kits/console/ConsoleApp.jsx`.

Agenda and month views, campaign pages and ICS feeds are phase 6 and are not
here.

*Tests*: an unauthenticated `GET /api/campaigns` is 401 and a non-organiser is
403; the list shape matches what the page renders; `/console` serves the SPA and
`not_found_handling` sends a deep link to it rather than to the holding page.

*Review focus*: no state read out of Discord to build this page — every field
comes from D1. And the holding page at `public/index.html` still says something
true once the console exists.

### 14. `p2/14-console-campaign` — entering a campaign, and moving it · #25

The write half for campaigns: `POST /api/campaigns`, `PATCH /api/campaigns/:id`
and `POST /api/campaigns/:id/transition`, with the form behind them — name,
kind, game, channel, role, colour, location type, anchor and interval, quorum,
capacity, `max_sessions`, `first_session_number`. Lifecycle actions are four
buttons with a confirmation step, and they call `transition` from `p2/5` rather
than writing `state`.

This is the PR that makes #26 possible, so the form has to accept a raw Discord
snowflake for channel and role — the ids come from `ops/adopted-ids.json`,
pasted by the operator, never guessed by the console.

*Tests*: creating a campaign writes an `audit_log` row naming the actor; an
illegal transition answers 409 and changes nothing; the anchor round-trips
through the form in the guild's zone and is stored as unix seconds; a `PATCH`
that omits a field leaves it alone rather than nulling it.

*Review focus*: every write goes through the domain functions the bot uses — no
route holds its own `update(campaigns)`. That is what keeps `audit_log` honest
and what stops the console becoming a second implementation of the lifecycle.

### 15. `p2/15-console-roster-games` — rosters and games · closes #25

The last two objects. Roster: list members, add and remove, set the GM, edit
character names — `POST`/`DELETE /api/campaigns/:id/members` and `PATCH` on one
member, over `rosterOf` and the member functions from `p2/6`. Games: list,
create and edit, over `games` from `p2/3`.

Adding a member means naming a Discord user who may never have interacted with
Orrey, so the row in `users` is created by id and the name filled in from the
guild member endpoint with the bot token — a cache, refreshed, never an
identity.

*Tests*: adding a member for an unknown discord id creates the user row and the
membership; removing the last GM is refused; every roster and game write lands
in `audit_log`; a member added here shows up as unheard-from on the next
attendance post, which is the through-line from `p2/6` and worth one end-to-end
test.

*Review focus*: `identify` is still the only scope, and the only thing read with
the bot token is the guild member — the console never asks Discord what
campaigns exist. After this the phase is code-complete and #26 is a keyboard,
not a PR.

## Landing order

Bottom-first: 1 → 2 → 3 → 4 → 5 → 6, and then the phase splits. From there
`p2/7`–`p2/9` (the clock) and `p2/10`–`p2/15` (the console) are independent of
each other and can land in either order, interleaved as review comes back. After
each merge, `npm run stack -- restack p2 --apply` and `npm run stack -- push p2
--apply`, then re-read the child PR's diff on GitHub — a squash plus a restack is
exactly where a change goes quietly missing.

`p2/10-console-login` forks off `p2/6-roster`, so tell the tooling once —
`npm run stack -- base p2/10-console-login p2/6-roster` — or the next restack
flattens the console line onto the materialiser and the two stop being
reviewable in parallel.

Two conflicts to expect. Both lines add keys to `SETTING_KEYS` in
`src/db/settings.ts` — horizon size and attendance lead time from `p2/8`, the
organiser role id from `p2/11` — and both add tables to the receipt in
`src/privacy/delete.ts`. Each resolves by keeping both sides; neither is a sign
the slicing was wrong.

The first two PRs are fixes to shipped phase-1 code rather than new domain work,
so they are also the two most worth landing quickly: everything above them
inherits the rule that a published object stays findable from D1, and nothing
above them should be written assuming it does not.

#26 is not a PR. Once the stack is in `main`, enter the four campaigns through
the console with the ids from `ops/adopted-ids.json`, set each
`first_session_number` so numbering continues from where Hermuz left off, attach
the live scheduled events by writing their ids into `publications` so the
projector adopts rather than duplicates, add the bot's role to each campaign
channel's permissions — it can currently see only GameHub, Information and
admin-stuff, per the comment on #26 — let the hourly materialiser fill the
horizon, confirm nothing doubled, and close #26 with what happened on the day.
