# Phase 3 as a stack

The plan for cutting [#5](https://github.com/alxjrvs/orrey/issues/5) — issues
#27–#33 — as twelve stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 3 is the first phase that opens with a surface rather than a migration.
Everything it writes was cut in phase 1 for it to fill in — `sessions.thread_id`,
`sessions.state`'s CONFIRMED / JEOPARDY / PLAYED members, `attendance.attended`
and `attended_source`, `users.dm_state` — and the two things it reads that phase
1 did not have, `campaigns.quorum` and `campaign_members`, arrive with #21 in
phase 2. So phase 3 adds no tables and no columns, and the bottom of the stack is
a Discord thread.

That makes phase 2 a precondition rather than a caveat: this stack is cut from a
`main` that already holds `p2/3-games` (quorum), `p2/4-roster-schema`
(`campaign_members`), `p2/6-roster` (`rosterOf`, and the attendance post already
listing roster members who have said nothing) and `p2/15-console-roster-games`
(the console roster page flake hangs off). A phase-3 PR carrying a phase-2
column's migration would collide with the migration that owns it, so no slice
here carries one. If phase 2 is not in `main`, phase 3 does not start.

Two things sit under the rest. The first is the thread: every time-triggered
thing in this phase is a new message, and all of them land in the session's
thread, so #27 is the bottom PR and the epic is right to order it first. The
second is job arming — the primitive that puts a row in `jobs` with an
idempotency key. It is not its own PR, because a PR never spans two issues:
`armJob` rides in with the first thing that needs it (#28's confirmed notice),
and the per-session `armSessionJobs` rides in with #29's T-24h check, which is
the first thing that has to be re-armed when a session moves.

What phase 3 does *not* have to do is read a roster. `p2/6-roster` already left
`src/attendance/rows.ts` returning roster members alongside the people who
answered and `src/attendance/render.ts` rendering the unheard-from line. Phase
3's only roster work is the denominator: quorum counts the people who said "in"
*and* are on the roster, which is a change to `quorumOf` and belongs to #28
rather than to a slice of its own.

After that the line is real rather than incidental: the confirmed notice needs
the thread and the crossing; the T-24h check needs arming and the quorum
reading; auto-assume needs arming and nothing else. Three slices depend only on
something low and **fork** rather than extend — `p3/11-upcoming` needs the
quorum reading, `p3/8-auto-assume` needs the arming hook but nothing about DMs,
and `p3/10-flake` needs the auto-assume write but not the correction post. The
fork at `p3/8` is the one that matters most: it puts #30 and #31 in review at the
same time instead of running the attendance line behind the reminder ladder it
has nothing to do with.

Send-only shapes the whole phase. Five of these twelve PRs post a message; none
of them edits one. The only rewrites are the crossing click in #28 and the
correction toggle in #31, each answering an interaction that came from the
message it rewrites.

```
main  (phase 2 landed)
 └── p3/1-session-thread (#27)
      └── p3/2-quorum (#28)
           ├── p3/3-confirmed-notice (#28)
           │    └── p3/4-jeopardy-check (#29)
           │         ├── p3/5-jeopardy-notice (#29)
           │         │    └── p3/6-dm (#30)
           │         │         └── p3/7-reminder-ladder (#30)
           │         └── p3/8-auto-assume (#31)
           │              ├── p3/9-correction-post (#31)
           │              └── p3/10-flake (#32)
           │                   └── p3/12-whos-in (#33)
           └── p3/11-upcoming (#33)
```

## Where this sits

Phase 2 is cut but not landed: #75–#89 are open, and #74 is its plan. Phase 3
needs the roster (#80), the jobs the materialiser arms (#82) and the Discord
event horizon (#83) — and none of the console. So this stack is based on
`p2/9-event-cap`, the top of phase 2's clock line, rather than on `main`.

When phase 2 lands, `npm run stack -- restack p3 --apply` moves the whole thing
onto `main` and the bases retarget themselves. Until then a phase-3 PR's diff
reads against its phase-2 parent, which is the only way for it to be reviewable
at all.

## The slices

### 1. `p3/1-session-thread` — the thread every later post lands in · closes #27

`src/discord/rest.ts` gains `startThreadFromMessage` —
`POST /channels/:channelId/messages/:messageId/threads`. A new
`src/discord/threads.ts` holds the two functions the rest of the phase calls:
`openSessionThread(env, target)`, which starts the thread from the session's
stored `discord_message_id` and writes `sessions.thread_id`, and
`sessionNoticeChannel(env, target)`, which answers "where does a notice for this
session go" — the thread, or the campaign channel, or `settings`' scheduling
channel. `src/attendance/post.ts` calls the first one straight after it records
the message id.

Thread-from-message rather than a standalone thread, because that makes the
attendance post the thread's starter message: the buttons people click stay
pinned at the top of the place every later notice lands, and the `name` in the
POST body is Orrey's, which is the half of #27's either/or that asks for a title
Orrey controls.

`auto_archive_duration` is set once at creation and never read again. Posting
into an archived thread un-archives it, but Discord does that itself as a side
effect of the POST — no code path here calls the un-archive endpoint, and none
calls a message edit. Starting a thread is a POST on the message's path, not a
PATCH of the message.

*Tests*: `test/session-thread.test.ts` — posting the attendance post opens
exactly one thread, from that message, named with the session's title; the id
lands on the session and a re-run of `session.post-attendance` opens no second
one; a thread that fails to open leaves the post in place rather than throwing
the job away; `sessionNoticeChannel` falls back to the campaign channel with no
thread and to the scheduling channel with no campaign; every Discord call in the
run is a POST.

*Review focus*: a thread is created by a POST, not by an edit — grep the diff for
`PATCH /channels`. The fallback exists so a session whose thread never opened
still has somewhere for its notices to go, rather than throwing on every job for
the rest of the phase.

### 2. `p3/2-quorum` — the click that crosses the threshold confirms · #28

A new `src/attendance/quorum.ts` holds `quorumOf(campaign, rows)` →
`{ needed, in, met }`, a pure function over `campaigns.quorum` and the rows the
post already has. It counts the people who said `in` *and* are on the roster:
quorum over whoever happened to click is not an answer to "does it run".
`p2/6-roster` already put roster members in those rows; if the row shape does not
yet say which is which, this PR adds the flag — a field on a row that is already
joined, not a second join. A campaign with no quorum is never met, at any count,
so nothing confirms itself by accident.

`src/do/session-lock.ts`'s `setIntent` recomputes it inside the same chained step
that wrote the intent and promotes `sessions.state` from SCHEDULED to CONFIRMED
when it crosses. It returns `{ rows, crossed }` instead of bare rows, so the
interaction response renders exactly what was written and the PR above has a
transition to hang a notice on; `readIntents` and `setNote` keep returning rows,
and `handleAttend` unpacks the one shape that changed. `src/attendance/render.ts`
grows the quorum line and computes it from `target.campaign` and the rows it was
handed, so the renderer stays pure and the modal path needs no change.

Dropping back below quorum after confirmation is rendered, not acted on: the row
stays CONFIRMED and the post reads `Confirmed — 3 of 4 in now`, naming the GM.
"Surface it, don't decide it" is a rule about the write, not only about the
wording.

No migration. `campaigns.quorum` is #21's column and arrived with `p2/3-games`;
this PR reads it.

*Tests*: `test/quorum.test.ts` for the pure function — quorum unset, an
off-roster `in` that does not count, exactly-at and one-below. Additions to
`test/attendance-click.test.ts`: the crossing click is the one that writes
CONFIRMED and the click before it writes no state at all; going four to three
after confirmation leaves the row CONFIRMED and changes only the line; the post
still renders under 1900 characters with the new line through all three
shortening passes.

*Review focus*: the state only ever moves up here. The count is read inside
`SessionLock`'s chain, in the same step that wrote the intent — read it outside
and six simultaneous clicks all see five. And the denominator: read `quorumOf`'s
off-roster case specifically.

### 3. `p3/3-confirmed-notice` — the notice the crossing click leaves · closes #28

A new `src/jobs/arm.ts` holds the primitive the rest of the phase builds on:
`armJob(env, { kind, payload, runAt, idempotencyKey })`, an insert with
`onConflictDoNothing` on `jobs.idempotency_key`. `src/do/session-lock.ts` arms
`session.notice` keyed `notice:confirmed:<sessionId>` in the same chained step
that recorded the crossing; `src/jobs/drain.ts` gains the case; a new
`src/notices/confirmed.ts` renders the short message and posts it to
`sessionNoticeChannel`.

A job rather than a post from inside the handler, for two reasons and the second
is the real one. The interaction has three seconds, and `handleInteraction` is
called from `src/http/app.ts` with an `InteractionContext` that carries an origin
and nothing else — there is no `ExecutionContext` here to hang a `waitUntil` on.
And the unique idempotency key is what stops a count that oscillates across the
threshold from posting five notices; a read-then-insert would not, under two
clicks arriving behind the same lock. The notice lands within a minute of the
click, which is soon enough for a message that says "this is running".

*Tests*: `test/confirmed-notice.test.ts` — crossing arms exactly one job, and
crossing again after dropping below arms none because the key is taken; the
notice posts into the thread when there is one and into the campaign channel when
there is not; a notice for a deleted session is a no-op like every other job;
nothing in the run touches the attendance post.

*Review focus*: `armJob`'s conflict handling is a constraint, not a check — the
uniqueness is on the column. The attendance post's own confirmed line came from
the click one PR below; this PR adds a *new* message and must not be able to
reach the old one.

### 4. `p3/4-jeopardy-check` — when Orrey asks, and what it records · #29

`src/jobs/arm.ts` gains `armSessionJobs(env, sessionId)`, called from the
`session.project` case in `src/jobs/drain.ts` — the one hook that already fires
whenever a session is created or moved, by the seed in phase 1 and by the
materialiser from `p2/8`. It arms a `jeopardy.check` row at T-24h keyed
`jeopardy:<sessionId>:<startsAt>`, so a rescheduled session arms a fresh check
and the stale one is cancelled rather than fired.

`src/jobs/drain.ts` gains the case: load the target, read `quorumOf`, and when it
is short write `sessions.state = JEOPARDY` — **only from SCHEDULED**. A session
that was CONFIRMED and has since dropped below keeps its state; un-confirming
stays the organiser's call, exactly as #28 has it. Quorum met writes nothing at
all.

Nothing is posted here. The check and the notice are separate PRs because the
check is "when does Orrey ask the question and what does it record", and the
notice is "what it says and who it names" — and because splitting them the other
way round would arm a job kind the drainer throws on, which is a job retrying
every minute until the PR above it lands. Silence is the current behaviour; a
half-written notice is not.

*Tests*: `test/jeopardy-check.test.ts` — projecting a session arms one check at
T-24h and re-projecting it arms none; moving the session arms a check at the new
time under a new key and the old one never fires; quorum met leaves `state`
alone; quorum short moves SCHEDULED to JEOPARDY; a CONFIRMED session that has
dropped below keeps CONFIRMED; a session inside 24 hours arms nothing rather than
arming a check in the past.

*Review focus*: the idempotency key carries `starts_at`, which is the whole
reason a reschedule cannot fire a stale check. And the one-way state write —
JEOPARDY is reachable from SCHEDULED and from nowhere else.

### 5. `p3/5-jeopardy-notice` — who has not answered, and who to talk to · closes #29

A new `src/notices/jeopardy.ts` renders what the check from the PR below has
already decided, and the `jeopardy.check` case posts it through
`sessionNoticeChannel`. The notice mentions the campaign role, names exactly the
silent roster members from the rows `p2/6-roster` returns, names the GM from
`campaign_members.role = 'gm'` as the person to talk to, and carries its own
as-of line.

There is no *Suggest another day* button. Date polls are phase 4, and a button
that opens nothing is worse than a name — #29's second checkbox says exactly
this, and the name is the version of it that exists today.

The notice goes out on the current reading, including for a session that was
CONFIRMED and has since dropped below quorum: the check asks the current
question, and that is the case the notice exists for. It still does not touch
that session's state, and it never touches the attendance post.

*Tests*: `test/jeopardy-notice.test.ts` — quorum met posts nothing; quorum short
posts one notice naming exactly the silent roster members and no one else; the GM
is named from the roster row, not from a Discord role read; a CONFIRMED session
below quorum gets the notice; the role mention is the only mention
`allowed_mentions` permits; a second drain of the same check posts a second
notice only if the job was re-armed, never from a retry of a completed one; no
PATCH anywhere in the run.

*Review focus*: the notice is a new message with its own as-of line — nothing
here may reach the attendance post, and nothing may read one. The silent list
comes from D1 rows, not from counting reactions or re-reading the post.

### 6. `p3/6-dm` — a DM first, and 50007 as the only way to learn · #30

`src/discord/rest.ts` gains `createDmChannel` (`POST /users/@me/channels`). A new
`src/discord/dm.ts` holds `dm(env, userId, payload)`: skip outright when
`users.dm_state = 'closed'`, otherwise open the channel and post; on code 50007
write `dm_state = 'closed'` and report the failure rather than throwing; on
success write `open`. Closed is permanent — the only write back to `open` is a DM
that actually went through, which a closed user can no longer reach.

A new `src/notices/nudge.ts` holds `nudge(env, target, userIds)`: DM each,
collect the refusals, and mention that set once in the session thread via
`sessionNoticeChannel`. One message for everyone who could not be reached, not
one per person.

This sits on the jeopardy line rather than forking off the thread PR, and the
reason is the PR above it: `p3/7-reminder-ladder` needs both `nudge` and
`armSessionJobs`, and a branch has one base. Forking the DM off `p3/1` would only
move the join, and would strand the ladder away from its arming.

*Tests*: `test/dm.test.ts` — a first DM to an `unknown` user opens a channel and
posts; 50007 sets `closed` and produces a thread mention instead; the next nudge
to that user opens no channel at all; a 50007 arriving as a bare object with no
prototype is still recognised; any other failure throws so the job retries; one
thread message names all three unreachable people.

*Review focus*: the trap is already documented in `src/discord/rest.ts` —
`DiscordError.isClosedDm` is a getter, and a `DiscordError` that crossed the
`GuildGovernor`'s RPC boundary keeps its fields and loses its prototype. Every
catch out here reads `asDiscordFailure(error)?.code === 50007`, never
`instanceof`.

### 7. `p3/7-reminder-ladder` — three steps from settings, silent people only · closes #30

`src/db/settings.ts` gains `SETTING_KEYS.reminderSteps`, a list of hours-before
defaulting to `[72, 24, 2]`, so the ladder changes without a deploy.
`src/jobs/arm.ts`'s `armSessionJobs` arms one `reminder.nudge` per step, keyed
`reminder:<sessionId>:<startsAt>:<hours>`, skipping steps already in the past —
a session booked two days out gets two reminders, not a backlog of three fired at
once.

`src/jobs/drain.ts` gains the case: load the rows, take everyone whose `intent`
is null or `maybe`, and hand them to `nudge`. `src/notices/nudge.ts` gains the
reminder body — the session, the time as `<t:…:R>`, and a link back to the
attendance post built from the guild, channel and message ids in D1, which is a
link and not an edit.

Both of the phase's clocks are now armed from the same function, which is what
makes a reschedule re-arm the jeopardy check and all three reminders in one
place. The audience is deliberately narrow: someone who already said "out" is not
nudged, because a reminder that pings them is the fastest route to a muted bot.

*Tests*: `test/reminder-ladder.test.ts` — three jobs armed a week out, two armed
two days out; a reschedule re-arms under new keys and the old ones never fire;
only null and `maybe` are nudged and an `out` is never touched; a closed-DM user
gets one thread mention and no DM attempt; an empty step list arms nothing; every
run posts a new message and edits none.

*Review focus*: the ladder reads its steps from `settings` with the default
written down beside the key, so a guild that has never set it still gets three.
And `armSessionJobs` now arms two kinds — check that a session with no campaign,
or one already past, arms neither rather than throwing and stopping the drain.

### 8. `p3/8-auto-assume` — assume what was said, and write it down · #31 · forks off `p3/4-jeopardy-check`

`src/jobs/arm.ts`'s `armSessionJobs` arms an `attendance.assume` row at
`ends_at`, keyed `assume:<sessionId>:<endsAt>`. A new `src/attendance/assume.ts`
does the work: for every roster member, `in → 1` and `out`, `maybe` and null →
`0`, with `attended_source = 'auto'`, and the session moves to PLAYED.
`src/jobs/drain.ts` gains the case.

The write is `WHERE attended IS NULL`, and that clause is the whole re-run story:
the job can fire twice, the row can be re-armed by hand, and a correction the GM
already made is never overwritten by a guess. `maybe` defaulting to 0 is the
organiser's call rendered as a default — it is marked `auto` precisely so the
post above can flip it.

This forks off `p3/4-jeopardy-check`, not off the reminder ladder. It needs the
per-session arming hook and the roster, and nothing about DMs — so #31 and #30
are in review at the same time instead of the attendance line queueing behind a
ladder it does not use.

Nothing is posted here. The correction post is the next PR, and keeping the write
and the post apart is what lets this one be read as "is the assumption right"
without also holding "is the permission check right".

*Tests*: `test/auto-assume.test.ts` — every roster member gets a row, including
the ones who never clicked; `maybe` lands as 0 and `auto`; someone who answered
but is not on the roster is left alone; a re-run after a `gm` correction leaves
that row alone; the session lands in PLAYED and a CANCELLED one is skipped
entirely; nothing is posted.

*Review focus*: `attended_source` is what phase 7's stats use to tell a guess from
a fact, so an assumption must never be written as `gm` and a correction must never
be reset to `auto`. And PLAYED is written once, from the job, not from a click.

### 9. `p3/9-correction-post` — one toggle per person, the organiser's only · closes #31

A new `src/attendance/correction.ts` renders the post — one button per roster
member, labelled with the name, SUCCESS or DANGER by `attended`, every
`custom_id` minted through `src/discord/custom-id.ts` as
`{ action: "attended", arg: userId, target: sessionId }`.
`src/attendance/assume.ts` posts it into the thread once it has written its rows,
so one session end produces one job and one post. `src/discord/interactions.ts`
gains the `attended` case in `handleComponent`: check the clicker is the
campaign's GM, flip `attended`, set `attended_source = 'gm'`, re-render from D1,
answer with `UPDATE_MESSAGE`.

Render and click are one PR rather than two because a correction post whose
toggles answer "this post is retired" is not a partial feature, it is a wrong
one — the toggles are the entire post.

Five buttons a row and five rows is 25 people, which is more roster than exists;
a 26th is reported rather than silently dropped.

*Tests*: `test/correction-post.test.ts` — a non-GM click gets an ephemeral refusal
and writes nothing; a GM click flips `attended` and sets `gm`; the response is
type 7 on the click's own message; an id for a user who is no longer on the
roster degrades to the retired-post response; the post renders 25 toggles in five
rows and refuses the 26th out loud; the re-render reads D1 and never the
interaction's own message body.

*Review focus*: the organiser gate is read from D1 — `campaign_members.role =
'gm'` — before the write, not from the interaction payload and not only before
the render. Every id goes through `custom-id.ts`, and the toggle rewrites its own
message and nothing else.

### 10. `p3/10-flake` — a query over what happened · closes #32 · forks off `p3/8-auto-assume`

A new `src/attendance/flake.ts` holds `flakeFor(env, campaignId, userIds)`: per
person, sessions attended over sessions they were on the roster for among PLAYED
sessions, and the current run of said-in-didn't-show counting back from the most
recent. `src/console/api.ts`'s roster response from `p2/15` carries it, which is
#32's second checkbox — as information for the organiser, never as an automatic
consequence.

No table. A denormalised counter drifts the moment a GM flips a toggle on the
post one branch over, and there is no volume here that a query cannot carry —
this is a handful of rows per campaign per year. No schema at all, in a phase
that adds none.

It reads what `p3/8-auto-assume` writes and nothing that `p3/9-correction-post`
adds, so it forks off `p3/8` and reviews in parallel with the correction post.

For a couple of months after cutover this says nothing, which is accepted and is
a rendering decision rather than a data one: a user with no history reads as
having no history, never as 0%. `/whos-in` reads the same function in `p3/12`.

*Tests*: `test/flake.test.ts` — a user with no history reads as no history, never
as 0%; three of four counts only PLAYED sessions they were on the roster for; a
SCHEDULED or CANCELLED session is not in the denominator; the streak counts
consecutive said-in-didn't-show newest first and resets on a session they
attended; a session where they said nothing is not a flake; the console roster
response carries the numbers and the 403 in front of it is unchanged.

*Review focus*: this is information, not a consequence. Nothing in this PR
changes what Orrey does — only what it can say.

### 11. `p3/11-upcoming` — the agenda, ephemeral, across everything · #33 · forks off `p3/2-quorum`

A new `src/commands/upcoming.ts` builds the agenda: every campaign the caller has
a `campaign_members` row on, the next session of each, ordered by `starts_at`
across campaigns rather than grouped by campaign — the point is one list, not
four. Each line carries the date as `<t:…:F>`, the session number, confirmed /
in jeopardy / short by n from `sessions.state` and `quorumOf`, and the caller's
own intent. `src/discord/interactions.ts` replaces the phase-0 stub in
`handleCommand` ("Nothing scheduled yet — Orrey is still being built.").

`src/discord/commands.ts` needs no change — `/upcoming` was registered at cutover
with no options, and the PR says so rather than leaving a reviewer to check.

It needs the quorum reading and the roster and nothing above them, so it forks
off `p3/2-quorum` and does not wait on the notice, reminder or attendance chain.
It renders a JEOPARDY session correctly before anything writes that state — the
state comes from D1 either way, which is what the test asserts by inserting one.

*Tests*: `test/upcoming.test.ts` — someone on no roster gets a sentence saying so,
not an empty message; sessions order by time across campaigns and each campaign
contributes at most its next one; a JEOPARDY session reads as in jeopardy and a
short one as short by n; the caller's own intent is theirs and not the loudest
answer; the response type is 4 and ephemeral.

*Review focus*: read-only means read-only. `/upcoming` may not arm a job, post a
message or write a row, and the flag it shows is the state in D1 — never
re-derived from a message. The command surface is still four.

### 12. `p3/12-whos-in` — the authoritative roster when a post has gone stale · closes #33

A new `src/commands/whos-in.ts` answers for the named session, or the caller's
next one when the option is omitted: roster rows grouped in / out / maybe / not
said, with flake from `flakeFor` alongside a name where there is enough history
to mean something. Ephemeral, read from D1, carrying its own as-of time — this
command exists because posts are snapshots, so it must not be one.

`src/discord/interactions.ts` replaces the "Rosters arrive in phase 2." stub —
phase 2 has come and gone by the time this lands — and gives the
`APPLICATION_COMMAND_AUTOCOMPLETE` branch something to say:
`src/discord/commands.ts` already declares `/whos-in`'s `event` option with
`autocomplete: true`, and until now the handler has answered every autocomplete
with `{ choices: [] }`. It resolves against upcoming sessions on the caller's own
rosters, capped at Discord's 25.

`src/discord/commands.ts` is untouched by this phase: both commands and their
option shapes were registered at cutover and have not moved. #33's third checkbox
is closed by re-running `npm run commands:register` once after this merges and
confirming the set is unchanged — a command against Discord recorded in the PR
body, not a diff.

*Tests*: `test/whos-in.test.ts` — with no option, the caller's next session on any
roster; with one, the named session, and a session on a roster they are not on is
refused rather than shown; autocomplete returns at most 25 upcoming choices and
only from the caller's own campaigns; flake appears only where there is history;
the grouping matches D1 and not the last posted message; ephemeral, and nothing
written.

*Review focus*: the command surface is still four — this fills in a stub and an
autocomplete branch that have both existed since phase 0. Autocomplete answers
inside Discord's three seconds off `sessions_campaign_idx`.

## Landing order

Bottom-first: 1 → 2 → 3 → 4. After that the phase splits three ways and stays
split: 5 → 6 → 7 is the rest of #29 and all of #30; 8 → 9 and 8 → 10 → 12 is #31,
#32 and half of #33; 11 can land at any point after 2. Land 11 before 12, or
`Closes #33` lands while `/upcoming` is still in review. After each merge,
`npm run stack -- restack p3 --apply` and `npm run stack -- push p3 --apply`,
then re-read the child PR's diff on GitHub — a squash plus a restack is exactly
where a change goes quietly missing.

Three branches fork, and the tooling has to be told once each or the next restack
flattens them back into the line:

```sh
npm run stack -- base p3/11-upcoming p3/2-quorum
npm run stack -- base p3/8-auto-assume p3/4-jeopardy-check
npm run stack -- base p3/10-flake p3/8-auto-assume
```

`p3/8-auto-assume` is the fork that earns the most: #31 depends on the arming
hook and the roster, and on nothing about DMs, so the attendance line does not
queue behind the reminder ladder. `p3/11-upcoming` is the one worth cutting early
— a read-only command over the quorum reading, with no dependency on the notice,
reminder or attendance chain, and the slice most likely to be reviewed by someone
who is not holding the rest of the phase in their head.

Expect three conflicts, all resolved by keeping both sides. `src/jobs/drain.ts`'s
`switch (job.kind)` gains a case in 3, 4, 7 and 8; `src/jobs/arm.ts`'s
`armSessionJobs` gains a step in 7 and a row in 8. In both files 3 and 4 are
consecutive on the line and conflict only if a restack replays them out of order,
but 7 and 8 are on different branches and will conflict for real — two cases in
one switch, two arms in one function, both kept.
`src/discord/interactions.ts`'s `handleCommand` gains a case in both 11 and 12,
which are also on different branches: when 11 lands, 12's restack stops there.

Phase 3 has no `ops` issue: every one of #27–#33 is code, and the stack ends at
`p3/12-whos-in`. It has two dependencies outside itself. The first is phase 2 in
`main` — `campaigns.quorum`, `campaign_members`, `rosterOf` and the console
roster page are all read here and none is created here. The second is #26, phase
2's ops issue: the four campaigns entered against their existing Discord ids,
with their rosters. Until that is done in the world there is no roster, and a
roster is what the jeopardy notice names, the reminder ladder nudges, and
auto-assume writes rows for. #26 is closed with what happened when the campaigns
are entered, not by anything in this stack. `npm run commands:register` after 12
lands is the same kind of step: a command run against Discord, recorded in the PR
body, not a change to a file.
