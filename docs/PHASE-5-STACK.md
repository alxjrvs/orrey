# Phase 5 as a stack

The plan for cutting [#7](https://github.com/alxjrvs/orrey/issues/7) — issues
#39–#42 — as thirteen stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 5 is the first phase that adds no new machinery — it adds a second parent.
A game day is a row that gets a session, and from there the Discord event, the
Google event, the thread, the reminders and the attendance post are the ones
phases 1–3 already built. So the stack is mostly one line, and the line is
ordered by what each piece has to exist for.

Two orderings are worth saying out loud, because both look backwards until you
ask what depends on what. The signup post (#41) sits *below* the lifecycle
(#40): `PROPOSED → SEATING` is defined as "post the signup post", so a
transition PR landing first would arm a `game-day.post-signup` job with no
handler — a job `runJob` throws on, which sends it back to `pending` with a
`last_error` and a growing backoff until the PR above it lands. The same rule is
why `game-day.lock` is armed and handled in one PR rather than armed in `p5/9`
and handled in `p5/10`. And the projection target (#40's first PR) sits below the
whole seating line, because `p5/8-seated-roster` posts the attendance post
through `loadProjectionTarget` and needs a target that knows the day.

Three schema PRs sit contiguously at the bottom even though `p5/3` does not
depend on `p5/2`. That is deliberate: each of them rebuilds a table, and parallel
drizzle migrations mean a conflicting journal on every merge. One line, one
linear journal, read the SQL after every restack.

Two things fork. `p5/12-multi-day` needs the renderer, the seat write and the
roster handoff — `p5/8` and below — and nothing from the lifecycle, so it hangs
off `p5/8` and is reviewed alongside #40 rather than behind it.
`p5/13-tables-played` needs `attendance.tables_played` and phase 3's correction
post and nothing else, so it hangs off `p5/2` and can land while the seating line
is still open.

Each transition ships with the thing that fires it. `PROPOSED → SEATING` is an
organiser action, so the console control that calls `transition` lands in the PR
that defines the transition — otherwise #40 lands as a function nobody can reach
and the phase cannot be exercised. That is also what keeps the command surface at
four: opening seating, locking and cancelling are console pages, not a fifth
command.

Phase 5 reads `games`, `signups`, `campaign_members` and `audit_log` from #21,
the console from #25, the thread per session from #27, the correction post from
#31, and the minimal `game_days` that #34 mints from a winning poll date. Phase 5
fills that row in rather than creating it.

None of those phases has landed, and phase 4 forks three ways, so the stack is
based on `p5/0-base` — an integration branch holding `p4/13-carry-over`,
`p4/16-forming-anchor` and `p4/17-auto-resolve` merged, and through `p4/0-base`
all of phases 2 and 3. It contains no code of its own; when the phases below land,
it empties out and `npm run stack -- restack p5 --apply` moves the whole stack
onto `main`.

```
p5/0-base  (phases 2, 3 and 4 merged)
 └── p5/1-game-days (#39)
      └── p5/2-one-off-session (#39)
           ├── p5/3-game-day-signups (#39)
           │    └── p5/4-projection-target (#40)
           │         └── p5/5-seat-post (#41)
           │              └── p5/6-seat-clicks (#41)
           │                   └── p5/7-waitlist-promotion (#41)
           │                        └── p5/8-seated-roster (#41)
           │                             ├── p5/9-transitions (#40)
           │                             │    └── p5/10-lock (#40)
           │                             │         └── p5/11-terminal-states (#40)
           │                             └── p5/12-multi-day (#42)
           └── p5/13-tables-played (#42)
```

## The slices

### 1. `p5/1-game-days` — what a game day is, beyond its date · #39

`src/db/schema.ts` plus the generated migration. Phase 4 minted `game_days` with
id, kind, date and a state because the untargeted poll had to put its winners
somewhere; this fills the row in — `venue` (what the EXTERNAL event carries as
its location), `host_user_id` referencing `users.discord_id`, `capacity`,
`game_id` referencing `games.id`, the full lifecycle state (`PROPOSED | SEATING |
LOCKED | PLAYED | CANCELLED`, defaulting to `PROPOSED`), and the three Discord
ids a day accumulates: `discord_channel_id`, `discord_message_id` for the signup
post, and `thread_id`.

`capacity` is nullable on purpose. A single day takes its seat count from
`games.max_players`; the column is the override for the evening the table only
has five chairs, and on a multi day it is the venue's cap or nothing at all. A
`game_days_single_game_ck` says a `single` day names a game — phase 4's win rule
already required one, and this is where that stops being a convention.

Widening the `state` CHECK is a table rebuild on SQLite, not an ALTER:
drizzle-kit emits `__new_game_days`, copies, drops and renames.

*Tests*: `test/game-day-schema.test.ts` — a `single` day with no game is refused;
a `multi` day with neither capacity nor game is accepted; the state default is
`PROPOSED`; a day minted by a phase-4 poll still points at its winning date after
the rebuild.

*Review focus*: no column phase 5 does not read. There is no `tables` table and
no per-table seating — #7's open question is settled as one optional free-text
column on `attendance`, which arrives one PR up. `PROPOSED` fails closed the way
`campaigns.state` defaults to `FORMING`: `isProjectable` learns to ask the day in
`p5/4`, and a day nobody has opened seating on is not a day Orrey publishes.

### 2. `p5/2-one-off-session` — exactly one parent · #39

`sessions` gains `game_day_id`, and `sessions_parent_ck` — written in phase 1 as
"a campaign session has a campaign, a one-off has none" — is rewritten as what it
was always standing in for: exactly one parent, and the one its `kind` names.
`attendance` gains `tables_played`: nullable free text on a table already keyed
`(session_id, user_id)`, so it is per person by construction. Nothing reads it
until `p5/13`.

This is the phase's dangerous migration. SQLite cannot alter a CHECK, so
`sessions` — the table `attendance`, `calendar_links` and phases 3 and 4's
children all reference — is rebuilt: new table, copy, drop, rename. The two
phase-1 indexes (`sessions_starts_idx`, `sessions_campaign_idx`) have to be
recreated on the new table, and the copy has to carry every row: a pre-existing
`one_off` with no game day would violate the new CHECK, so the migration asserts
there are none rather than letting the copy quietly drop them.

A game day gets a session row so that attendance, the thread, the Discord event
and the Google event reuse the machinery they already have. Nothing mints one yet
— that is `p5/9`.

*Tests*: `test/schema.test.ts`, extended — a one-off hanging off a game day is
accepted; one with both parents is refused; one with neither is refused; and,
after the migration, a campaign session still joins to its attendance rows and
its `calendar_links` row, which is the only thing that proves the rebuild kept
its references.

*Review focus*: read the generated SQL, not the drizzle schema — a rebuild is
exactly how a CHECK or an index goes quietly missing. `tables_played` sits here
rather than with the button that fills it because the column is a #39 checkbox
and the button is a #42 one, and a PR does not span two issues; the fork at
`p5/13` is what that buys.

### 3. `p5/3-game-day-signups` — a second target, and a waitlist order · closes #39

`signups.target_type` gains `game_day` alongside phase 2's `campaign_forming`,
`state` gains `seated | waitlisted | out`, and `position` starts being read. The
CHECK phase 2 wrote — a signup never targets a session — stays, and has to be
re-asserted by hand in the rebuild that widening `target_type` forces.

`position` is arrival order within a target, assigned under the lock and never
touched again. Seated versus waitlisted is `state`. That is the decision that
makes promotion cheap: promoting the head of the waitlist is one row changing
state, not a renumbering, so replaying it is a no-op and two promotions racing
cannot interleave into a gap.

A unique index on `(target_type, target_id, user_id)` gives one row per person
per day; an index on `(target_type, target_id, position)` makes "who is next" a
read rather than a scan.

*Tests*: `test/game-day-signups.test.ts` — a signup whose `target_type` is
`session` is refused, in the rebuilt table as well as before it; a second signup
by the same person for the same day collapses onto the first; positions come back
in arrival order; phase 2's `campaign_forming` rows survive the rebuild.

*Review focus*: "signups attach to campaigns at formation and to game days —
never to an individual session" is an invariant in `CLAUDE.md`, and a CHECK
constraint is the only thing enforcing it. This PR drops and recreates the table
that holds it. It does not depend on `p5/2` and could have forked; it does not,
because two drizzle migrations in flight against the same schema conflict in the
journal on every merge, and the three schema PRs are cheaper to read as one
contiguous block anyway.

### 4. `p5/4-projection-target` — the target grows a second parent · #40

`src/projection/target.ts` learns that a session may hang off a game day.
`ProjectionTarget` gains `gameDay`, `loadProjectionTarget` takes a second left
join through `sessions.game_day_id`, `sessionTitle` renders a day (the game's
name for a `single`, the day's own title for a `multi`), and
`googleProjectedContent` takes the venue as the location — so both fingerprints
move when the venue moves, without either projector gaining a branch.

The change with teeth is `isProjectable`. Its comment today says a session with
no campaign is always projectable, because in phase 1 that meant "a one-off, and
nobody has one". After `p5/2` that case is unreachable: a session has exactly one
parent. So the function stops testing for absence and starts asking whichever
parent is there — a campaign publishes when `RUNNING`, a day publishes in
`SEATING`, `LOCKED` or `PLAYED` — and a session with neither parent, which the
CHECK forbids, is not projectable. Every unknown state falls to the same answer.

`src/discord/events.ts` changes in one place: `entity_metadata: { location:
session.location ?? "To be confirmed" }` takes the day's venue when there is a
day. The `location_type === "voice"` branch above it never fires for a day — a
day has no campaign, so there is no voice channel to inherit.

*Tests*: `test/projection.test.ts` — a day in `SEATING` projects and one in
`PROPOSED` does not; a delete for a `CANCELLED` day still goes out, because
`project`'s retract branch is not gated on projectability; the fingerprint moves
when the venue moves. `test/discord-event.test.ts` — the day's event is EXTERNAL
and carries the venue. `test/gcal.test.ts` — the id is the same deterministic
base32hex id minted from the session id.

*Review focus*: no projector gains a game-day code path — both still take a
`ProjectionTarget` and read it. `isProjectable` fails closed. Writes still name
the Orrey calendar only. This PR needs `p5/1` and `p5/2` and not `p5/3`; it sits
above `p5/3` because `p5/8` needs both this and the whole seating line, and a
stack has no way to say "based on two branches".

### 5. `p5/5-seat-post` — the signup post · #41

The seating stage's post, built the way the attendance post was:
`src/game-days/render.ts` is a pure function of rows and an as-of time,
`src/game-days/signups.ts` is the read from D1 that feeds it, and
`src/game-days/post.ts` sends it once, opens the thread and records
`game_days.discord_message_id` and `game_days.thread_id`. A
`game-day.post-signup` case in `src/jobs/drain.ts` is what runs it; nothing arms
that job yet.

Five buttons, which is exactly one action row: **Take a seat** / **Waitlist** /
**Out** / *Can't make this one — suggest a day* / **Refresh**. The fourth hands
off to phase 4's poll opener rather than minting a second path into date-finding.
Every id goes through `src/discord/custom-id.ts` as `o1:seat:<arg>:<gameDayId>`.

The seat count is `game_days.capacity ?? games.max_players`. The audience is the
whole server, so unlike the attendance post there is no role to mention and
`allowed_mentions` parses nothing and lists no roles.

The length fallback is not written again: `escapeMarkdown` is already exported
from `src/attendance/render.ts`, and the day's renderer imports it and does the
same three passes — notes, then names, then the counts that answer the question —
because a post over 2000 characters is a post whose every later click is
rejected, and under send-only there is no shortening it afterwards.

*Tests*: `test/game-day-post.test.ts` — the renderer takes its clock as an
argument, so what a click renders is what a test renders; the day's capacity
overrides the game's; ids round-trip through `decodeCustomId`; running the job a
second time finds the recorded message id and posts nothing.

*Review focus*: send-only. The message id is recorded and then forgotten; nothing
here edits a message and nothing reads one back. Opening a thread on the post is
a create, not an edit.

### 6. `p5/6-seat-clicks` — the click that takes the last seat · #41

`src/do/session-lock.ts` gains `takeSeat`, `leaveSeat` and `readSeats`, and
`src/discord/interactions.ts` gains a `seat` case in `handleComponent` that
answers with `UPDATE_MESSAGE`. No new Durable Object class and no new binding:
the existing `SESSION_LOCK` is taken by the game-day id. The lock is per
clickable thing, and a day and its session are different things, clicked by
different people at different times — a new class would also be a wrangler
migration for nothing.

Capacity is decided inside the lock, which is the whole reason the lock is there:
the click that takes the last seat has to be the click that renders the full
post. Overflow is not refused; it becomes `waitlisted` at the next `position`, so
**Take a seat** on a full day and **Waitlist** land in the same place and the
person is told which by the post they get back. Each method returns the rows it
just wrote, so the response renders what was written without going back to look.

*Tests*: `test/seat-click.test.ts` — six clicks against five seats produce five
seated and one waitlisted in arrival order; clicking twice does not take two
seats; going Out and back takes the next free seat rather than the old one; an
unknown id gets the retired-post response; the handler reads D1 only, and the
interaction's own `message` is never parsed.

*Review focus*: type 7 answering the click's own message, and nothing else that
touches a posted message. The rest of the server sees a stale post until their
next Refresh, and that is the design, not a gap.

### 7. `p5/7-waitlist-promotion` — a freed seat, and a new post saying so · #41

`src/game-days/promote.ts`, called from inside the same serialised `leaveSeat`
chain that freed the seat — outside it, two people going Out at once could
promote the same person twice. It returns who moved, and
`src/game-days/notice.ts` posts a new message in the day's thread mentioning
them.

A promotion is a state change, not a renumber: the promoted row keeps its
`position` and becomes `seated`. So replaying it finds nobody to promote and
posts nothing, which is what makes it safe to run again from a retried job later.

What is deliberately absent: any rewrite of the signup post. The person who
clicked Out already got it rewritten as their own interaction's response; the
promoted player is told by a post addressed to them; everyone else finds out on
Refresh. Anything changing from outside posts a new message — that is the rule
the whole send-only design rests on.

*Tests*: a seated Out promotes exactly one person, the one at the lowest
position; two Outs landing together promote two different people; an empty
waitlist posts nothing at all; a waitlisted person going Out promotes nobody; the
notice's `allowed_mentions.users` is exactly the one promoted id and `parse` is
empty.

*Review focus*: the mention list. A notice that pings a role, or parses a user id
out of somebody's text, is the one way this post can be louder than it means to
be.

### 8. `p5/8-seated-roster` — the seated are the roster · closes #41

Stage three for a game day, which is stage three for a campaign session with a
different answer to one question: who is the roster. `src/attendance/rows.ts`
gains that answer — for a game-day session the roster is the `seated` signups, so
the post can show who has not answered, the same way `campaign_members` let it in
phase 2. `src/attendance/post.ts` sends a game day's post into
`game_days.thread_id`; today it falls back from `campaign?.discordChannelId` to
the scheduling channel, and a day is neither.

There is no game-day attendance post. It is `renderAttendancePost`, the five
buttons phase 1 minted, and phase 3's reminder ladder and jeopardy check, all
reading a different roster. The jeopardy threshold for a single day is the game's
`min_players` — the same number phase 4's default win rule used.

*Tests*: the day's attendance post lists every seated player as unanswered and no
waitlisted one; the post goes to the day's thread and not to the scheduling
channel; jeopardy for a single day trips at the game's minimum rather than a
campaign quorum; a waitlisted player promoted after the post exists appears on
the next render.

*Review focus*: that nothing was duplicated. If this PR adds a second renderer, a
second post helper or a second reminder job, the slice is wrong — the whole
argument for giving a game day a session row is that it does not need any of
those.

### 9. `p5/9-transitions` — the lifecycle as one function · #40

`src/game-days/lifecycle.ts`: one `transition(env, gameDayId, to, actor)`, a
legal-move table (`PROPOSED → SEATING | CANCELLED`, `SEATING → LOCKED |
CANCELLED`, `LOCKED → PLAYED | CANCELLED`, `PLAYED` terminal), and an illegal
move that throws rather than quietly doing nothing. Every transition writes an
`audit_log` row, so the console and the clock leave the same trail.

`PROPOSED → SEATING` is where the day becomes a thing with a calendar presence.
It mints the session row — `kind: 'one_off'`, `game_day_id`, `starts_at` from the
day's date and `ends_at` from the game's default duration — then arms three jobs:
`session.project`, `game-day.post-signup`, and phase 3's `attendance.assume` at
`ends_at`. Each carries an idempotency key derived from the day and the
transition, so a re-run is a no-op and a half-finished transition can simply be
run again. The fourth job a SEATING day wants, `game-day.lock`, is armed one PR
up alongside the handler that runs it — arming a job kind `runJob` does not know
is how you get a row retrying into `last_error` until the PR above it lands.

Opening seating is an organiser action, so this PR also adds the **Open seating**
control on the console's day view, which is the only caller `transition` has
until `p5/10`. That is what keeps the command surface at four: administration
belongs in the console.

*Tests*: `test/game-day-lifecycle.test.ts` — a day that reaches `SEATING` has
exactly one session, hanging off the day and no campaign; transitioning twice
does not mint a second; the three armed jobs are the three, with keys that
collide on a replay; an illegal transition throws and leaves both the day and the
jobs table untouched; the console control refuses a non-organiser.

*Review focus*: one function and no second path — the console control, the lock
job and the assume job all call it. The CHECK from `p5/2` is what stops a minted
session from carrying two parents, so nothing here defends that by hand. This is
the biggest slice in the phase; if the console control grows past a button and a
POST handler, it splits off rather than pushing this over 400.

### 10. `p5/10-lock` — the lead-time lock, armed and handled together · #40

`transition`'s `PROPOSED → SEATING` arm now includes `game-day.lock` at the lead
time; `src/jobs/drain.ts` gains the case that runs it, moving a `SEATING` day to
`LOCKED` and doing nothing at all to a day the organiser already locked by hand.
The console's day view gains **Lock now**, which calls the same `transition`.

Locking closes signups, and the seat buttons on the posted signup post outlive it
— a post is never edited, so the buttons are still there. The `seat` handler
gains the branch that reads the day's state first: a click on a `LOCKED` day
writes nothing and answers ephemerally with what happened. It does not rewrite
the post, because nothing changed, and rewriting it would make a stale reading
look fresh.

*Tests*: the lock job at the lead time locks a `SEATING` day and is harmless on a
`LOCKED` one; a `PROPOSED → SEATING` transition arms it with a key that collides
on a replay; a seat click after locking leaves `signups` untouched and answers
ephemerally rather than with type 7; **Lock now** on a `PLAYED` day is refused by
the legal-move table rather than by the console.

*Review focus*: the ephemeral refusal. It is the one place in the phase where the
natural reflex — rewrite the post so it says "locked" — is wrong, because the
post is a snapshot and Refresh is how a snapshot becomes current.

### 11. `p5/11-terminal-states` — how a day ends · closes #40

The two ways a day stops being a day anyone can act on.

`LOCKED → PLAYED` rides phase 3's `attendance.assume` job at `ends_at`: the
handler gains one branch — if the session hangs off a game day, call
`transition(..., 'PLAYED')` after it has written the assumed attendance. No new
job, no new clock.

`CANCELLED` is reachable from anywhere before `PLAYED`, from the console's
**Cancel** control. It calls `enqueueUnprojection`, which already exists and
already sends both `discord.event.delete` and `gcal.delete`, and posts one
cancellation notice in the day's thread. It never touches the signup post.

*Tests*: the assume job at `ends_at` moves a `LOCKED` day to `PLAYED` and leaves
a campaign session's behaviour exactly as it was; a day already `CANCELLED` is
not moved to `PLAYED` by a late assume; cancelling enqueues both deletes and
posts exactly one notice; cancelling twice posts one notice and enqueues one
pair.

*Review focus*: grep the diff for `PATCH /channels/:id/messages/:id` — the cancel
path is the one place in this phase where reaching for it would feel natural, and
the notice is the answer. The deletes are not gated on the day still being
projectable: `project`'s retract branch already handles that deliberately, and
gating them would strand a cancelled day's event on somebody's calendar forever.

### 12. `p5/12-multi-day` — coming to the day? · closes #42 · forks off `p5/8`

A multi day is a hangout, so stage two asks one question — coming to the day?
`src/game-days/render.ts` gains the variant: **Coming** / **Out** / *suggest a
day* / **Refresh**, no seat count, and no waitlist unless `game_days.capacity` is
set, in which case it behaves exactly like a single day's — overflow is
waitlisted and a freed place promotes the head.

That falls out of `p5/6` rather than being written again: the seat write already
reads a capacity, and a null capacity means unbounded. The handler gains `coming`
as an argument alongside `seat`; `src/game-days/post.ts` picks the variant from
`kind`; and everything above the render — the roster handoff, the attendance
stage — is untouched.

What is absent: any notion of a table. Tables form on the day; what gets recorded
is recorded afterwards, and that is `p5/13`.

This branch forks off `p5/8`. It needs the renderer, the seat write and the
roster handoff, and nothing from the lifecycle, so it is reviewed alongside #40
rather than behind it.

*Tests*: a multi day with no capacity never waitlists anyone however many click
Coming; one with a capacity waitlists past it and promotes the same way a single
day does; the post carries no seat count when capacity is null; the seated roster
handoff is literally the same code path as a single day's.

*Review focus*: one renderer with two variants rather than two renderers — the
difference is a capacity and two button labels. `Closes #42` sits here because
this is the last of #42 to land; the forked `p5/13` lands before it.

### 13. `p5/13-tables-played` — the optional field on the correction post · #42 · forks off `p5/2`

Phase 3's correction post — the organiser-only per-person attended toggles from
#31 — gains one more affordance on a multi day: **Tables played**. It needs
`attendance.tables_played` from `p5/2` and nothing else in this phase, so it
forks there and can be reviewed while the seating line is still open.

The post already spends its component budget on one toggle per person, and a
modal holds five inputs, which a multi day's roster outgrows. So it is one
button, and the chain it opens is ephemeral: the button answers with an ephemeral
message holding a string select of the people marked attended; picking one opens
a modal prefilled from D1 with their current line; submitting stores it and
answers ephemerally with what was stored. The correction post itself is never
rewritten by this chain — rewriting it would replace the toggles everyone else is
using with one organiser's select, permanently. The line appears on the post's
next Refresh, which is how every other stale reading becomes current.

The field is free text, optional, one row per person, and filled by whoever ran
the day rather than claimed by each player. That is #7's open question settled,
and #39's fourth checkbox is the column it lives in.

*Tests*: `test/tables-played.test.ts` — the select and the modal ids round-trip
the session and the person through `src/discord/custom-id.ts`; a non-organiser
click is refused by the same guard the attended toggles use; the modal is
prefilled from D1 and never from the message; a stored line is escaped by the
same `escapeMarkdown` a note is, because it is somebody else's text on a post
Orrey can never edit; the button is absent on a campaign session and on a single
day.

*Review focus*: escaping and organiser-only. Also the id budget — namespace plus
action plus user id plus session id has to stay inside Discord's hundred
characters, which `encodeCustomId` throws on rather than truncating.

## Landing order

Bottom-first: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8, then the lifecycle line 9 → 10 → 11.
After each merge, `npm run stack -- restack p5 --apply` and push.

Two forks, told to the tooling once each, because a fork it has not been told
about is one the next restack flattens back into the line:

```sh
npm run stack -- base p5/12-multi-day p5/8-seated-roster
npm run stack -- base p5/13-tables-played p5/2-one-off-session
```

`p5/13-tables-played` may land any time after `p5/2`, and should: it is the
earliest thing in the phase that can be reviewed in parallel. `p5/12-multi-day`
may land any time after `p5/8`, in either order against 9, 10 and 11 — but
**after** `p5/13`, because `p5/12` is the one carrying `Closes #42` and an issue
should not close with a PR of its own still open.

Expect three conflicts, all small. `p5/13` and the seating line both add a case
to the component switch in `src/discord/interactions.ts` and a branch to
`handleModal`'s id check — keep both. `p5/12` adds a `coming` argument to the
same `seat` handler `p5/10` adds a locked-day branch to — keep both. And `p5/1`,
`p5/2` and `p5/3` each rebuild a table in SQLite, so if two of them are in flight
the generated migration in the upper one has to be regenerated after the lower
one lands rather than rebased: read the SQL after every restack, not the drizzle
schema.

Phase 5 has no `ops` issue: #39, #40, #41 and #42 are all code, and the stack
ends at `p5/12-multi-day`. Running the first real game day on it is worth doing
before phase 6 starts, but it is not tracked, and if it is ever filed it is
closed with what happened on the day, not with a PR.