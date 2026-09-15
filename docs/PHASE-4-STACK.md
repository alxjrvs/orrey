# Phase 4 as a stack

The plan for cutting [#6](https://github.com/alxjrvs/orrey/issues/6) — issues
#34–#38 — as seventeen stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 4 has one mechanism and three consequences, and that is how it stacks.
Everything of #35 — the schema under it, the post, the select, the win rule,
Canonise, and the close notice — is one trunk, because both uses need all of it
and neither can be reviewed against half of it. The uses fork off the top of
that trunk.

The fork point is `p4/8-poll-close`, not Canonise. A poll that cannot close is
not the whole mechanism, and both uses arm a `poll.close` job; hanging the
untargeted line off Canonise would give it a poll with a live select and no way
to stop it.

The untargeted line then forks off `p4/10-reschedule` rather than off the trunk,
because both Discord entry points are the same
`APPLICATION_COMMAND_AUTOCOMPLETE` handler and the same date parser — #37's
"from a GM in the scheduling channel" is a synthetic choice in `/reschedule`'s
autocomplete, not a fifth command. That is a real dependency and this plan
states it rather than pretending the two uses are independent all the way down.
It still buys the parallelism that matters: after `p4/10` lands, three PRs of
#36 and three of #37 are in review at the same time.

Auto-resolve (#38) forks off `p4/8-poll-close` on its own. It decides *when*
Canonise runs, never *how*, so everything it touches — `src/polls/respond.ts`,
`src/polls/win-rule.ts`, `src/polls/canonise.ts` — is on the trunk beneath it.
Sitting it on top of the whole reschedule chain, as an earlier draft did,
serialised it behind five PRs it does not read a line of.

Phase 4 reads things phases 2 and 3 bring: `games` and `campaign_members` (#21),
`campaigns.recurrence_anchor` (#23), the console (#24, #25), `sessions.thread_id`
(#27) and the jeopardy notice (#29).

Neither phase has landed, and no single phase-3 tip carries all of that — the
phase forks three ways. So the stack is based on `p4/0-base`, an integration
branch holding `p2/15-console-roster-games`, `p3/7-reminder-ladder`,
`p3/9-correction-post`, `p3/11-upcoming` and `p3/12-whos-in` merged together. It
contains no code of its own; when phases 2 and 3 land, it empties out and
`npm run stack -- restack p4 --apply` moves the whole stack onto `main`.

```
p4/0-base  (phases 2 and 3 merged)
 └── p4/1-poll-schema (#34)
      └── p4/2-game-days (#34)
           └── p4/3-poll-render (#35)
                └── p4/4-poll-post (#35)
                     └── p4/5-poll-select (#35)
                          └── p4/6-win-rule (#35)
                               └── p4/7-canonise (#35)
                                    └── p4/8-poll-close (#35)
                                         ├── p4/9-parse-dates (#36)
                                         │    └── p4/10-reschedule (#36)
                                         │         ├── p4/11-suggest-a-day (#36)
                                         │         │    └── p4/12-move-session (#36)
                                         │         │         └── p4/13-carry-over (#36)
                                         │         └── p4/14-untargeted-open (#37)
                                         │              └── p4/15-mint-game-days (#37)
                                         │                   └── p4/16-forming-anchor (#37)
                                         └── p4/17-auto-resolve (#38)
```

## The slices

### 1. `p4/1-poll-schema` — one poll, its dates, and the answers · #34

`src/db/schema.ts` plus the generated migration, in the shape the phase-1 tables
already have — text ids, unix seconds, `check` and `index` in the table's third
argument:

- `date_polls` — id, nullable `target_session_id`, `campaign_id`, `game_id`,
  `game_day_kind`, `win_rule` (`min_players` | `quorum_of_roster` |
  `best_available` | `organiser_picks`), `win_threshold`, `status`
  (`open` | `closed`), `opened_by`, `closes_at`, `discord_channel_id`,
  `discord_message_id`.
- `poll_dates` — poll id, `starts_at`/`ends_at`, `outcome`
  (`open` | `won` | `lost` | `withdrawn`).
- `poll_responses` — `poll_date_id`, `user_id`, `available`, `responded_at`,
  primary key on the pair.

The partial unique index is the point of the PR:
`CREATE UNIQUE INDEX … ON date_polls(target_session_id) WHERE status = 'open'
AND target_session_id IS NOT NULL` — at most one open poll per target session,
enforced by SQLite rather than by a handler that could race with itself.

`src/db/ids.ts` arrives with it: `mintId()`, twelve base32hex characters from the
same `crypto.getRandomValues` shape `mintFeedToken` uses in `src/db/users.ts`.
Poll and poll-date ids ride inside `custom_id`, and `encodeCustomId` throws over
100 characters, so an id's length is a schema decision rather than a detail.

Two deliberate absences. `game_days` is the next PR. And there is **no
`auto_resolve` column on `date_polls`**, which diverges from #34's fourth
checkbox on purpose: #38 specifies the flag as `campaigns.auto_resolve_polls`, a
poll-level copy would have to be written by an opening path that does not exist
for another nine PRs, and a column nothing in the phase reads is exactly what the
review gate is looking for. `p4/17` reads the campaign's flag live, through
`date_polls.campaign_id`.

`withdrawn` is in the `outcome` enum because #34 names it. Nothing in phase 4
writes it, and a reviewer should expect that.

*Tests*: `test/poll-schema.test.ts` — two open polls for the same session fail; a
second poll for that session succeeds once the first is `closed`; two open
untargeted polls coexist, because the index skips nulls; `poll_responses` holds
one row per person per date; minted ids are distinct and round-trip through
`encodeCustomId`/`decodeCustomId` well inside 100 characters.

*Review focus*: no column phase 4 does not read. `win_rule` and `win_threshold`
are read by `p4/6`; `game_id` and `game_day_kind` by `p4/14`; `campaign_id` by
`p4/16` and `p4/17`. Venue, capacity, host and seating are phase 5's and must not
appear.

### 2. `p4/2-game-days` — what a winning date mints · closes #34

`game_days` — id, `kind` (`single` | `multi`), `starts_at`/`ends_at`, `title`,
`state` (`PROPOSED` → `SEATING` → `LOCKED` → `PLAYED`, or `CANCELLED`) — and the
one link phase 4 needs: `poll_dates.game_day_id`.

It is a separate PR from the tables below because it is a separate idea: those
describe a poll, this describes what a poll produces. Everything else about a
game day — capacity, venue, host, `game_id`, seating, and the `signups` CHECK
that binds signups to campaigns and game days — is phase 5's, and none of it is
read here.

*Tests*: `test/game-days.test.ts` — `state` defaults to `PROPOSED`;
`poll_dates.game_day_id` is nullable and clears when the day is deleted; the
phase-1 `sessions_parent_ck` is untouched and still rejects a session with
neither parent, because a game day does not become a session's parent until
phase 5.

*Review focus*: that this is genuinely minimal. A column added here "because
phase 5 will want it" is a column no test in this phase reads.

### 3. `p4/3-poll-render` — ten dates in one select · #35

`src/polls/render.ts` — the post as a pure function of rows, the same shape
`src/attendance/render.ts` proved: candidate dates as `<t:…:F>` so each reader
sees their own timezone, a tally per date, the as-of line, and the components.
Five buttons per row is why the answer is a `STRING_SELECT` — one option per
candidate date, valued by `poll_date` id, `min_values: 0` and `max_values` the
number of dates — with a second action row holding **Refresh** and **Canonise**.

Every id is minted through `src/discord/custom-id.ts`, which encodes
`action:arg:target`: `o1:poll:select:<pollId>`, `o1:poll:refresh:<pollId>`,
`o1:poll:canon:<pollId>`. One `case "poll":` in `handleComponent` will carry all
of them.

`escapeMarkdown` moves out of `src/attendance/render.ts` into
`src/discord/markdown.ts` and both renderers import it. A poll's title and a
campaign's name are somebody else's text on a post Orrey can never edit.

Nothing sends this yet — that is the next PR — so the renderer is reviewable as
one idea, exactly as `p1/5-attendance-render` was.

*Tests*: `test/poll-render.test.ts` — pure (the clock is an argument, no fetch,
no D1); ten dates produce ten options and `max_values: 10`; the select is alone
in the first row and the two buttons are the second; `allowed_mentions.parse` is
empty; a title full of backticks and underscores comes back escaped; every id
round-trips through `decodeCustomId`.

*Review focus*: send-only — nothing here reads a message or edits one. And the
100-character `custom_id` ceiling: a twelve-character poll id leaves room, and
the test that proves it is cheaper than the outage that finds out.

### 4. `p4/4-poll-post` — sent once, from a job · #35

`src/polls/rows.ts` loads a poll, its dates and their tallies from D1 in one
query. `src/polls/post.ts` — `postPollPost` — renders that, sends it through
`throughGovernor`, and records `discord_channel_id`/`discord_message_id`, then
forgets them, exactly as `src/attendance/post.ts` does. Like that one, it guards
on the stored id rather than being idempotent by write: a second post is a second
post, and only the newest one's components should be the ones people are
clicking.

The `poll.post` job kind lands in `src/jobs/drain.ts` here, in the trunk, because
both uses arm it and a job kind that exists on one fork only is a job kind the
other fork has to invent again. Posting from the drain rather than inside the
interaction is what keeps every outbound message inside `GuildGovernor` and off
the interaction's three-second budget — the same reason phase 1 posted attendance
from `session.post-attendance`.

Nothing arms the job yet; the two opening paths are six and ten PRs up. The test
inserts the `jobs` row directly.

*Tests*: `test/poll-post.test.ts` — the drain sends one message and stores its
id; a re-run of the same job finds the id and sends nothing; a poll whose row is
gone acks rather than throwing forever; the channel comes from the poll, not from
a constant.

*Review focus*: that the id is recorded and then abandoned. Nothing in this PR,
or any later one, may go back to that message except as the response to a click
that came from it.

### 5. `p4/5-poll-select` — the answer replaces the old one · #35

`MESSAGE_COMPONENT` handling for `o1:poll:select` and `o1:poll:refresh` in
`src/discord/interactions.ts`, routed into `src/polls/respond.ts`.

Discord sends the **complete** selection in `data.values` every time, so the
write is a replacement, not a toggle: delete this person's rows for this poll,
insert one per selected date. An empty selection is a real answer — "none of
these work" — which is why `min_values` is 0 and why the delete happens even when
nothing comes back.

Serialising needs a lock per poll, not per session: `src/do/poll-lock.ts` adds a
`PollLock` Durable Object, a `POLL_LOCK` binding in `wrangler.jsonc`, and a **new
migration tag** — `{ "tag": "v2", "new_sqlite_classes": ["PollLock"] }`, because
classes cannot be added to the existing `v1`. It chains its work the way
`SessionLock` does, since every read and write inside it is a D1 call and the
input gate reopens across those.

The response is `UPDATE_MESSAGE` (type 7) rendering what was just written: the
click *is* the re-render. Refresh is the same handler with no write, and it rides
here rather than one PR up for the reason phase 1 gave — a posted select beside a
Refresh button answering "this post is retired" is worse than no Refresh at all.
**Canonise** is on the post from `p4/3` and falls through to the retired-post
response until `p4/7`; that is the one loose end this slice leaves, and it is
loose for two PRs, in a branch, not in a channel.

*Tests*: `test/poll-select.test.ts` — two people selecting at once produce one
correct tally; re-selecting a narrower set removes the dropped dates; an empty
selection clears every row for that person; the handler never reads
`interaction.message` (the fixture's message content is a lie, as in
`test/attendance-click.test.ts`); an unknown poll id answers the retired-post
response.

*Review focus*: the replacement semantics and the lock around them. Also that
`POLL_LOCK` is a new class under a new tag — a mis-tagged migration is a
deploy-time failure, not a test-time one.

### 6. `p4/6-win-rule` — four ways to decide a date has won · #35

`src/polls/win-rule.ts`: tallies, `win_rule`, `win_threshold` and roster size in,
winning `poll_date` ids out. No D1, no clock, no env.

- `min_players` — the threshold comes from the poll's `win_threshold`.
- `quorum_of_roster` — the threshold is a fraction of `campaign_members` (#21),
  passed in as a count.
- `best_available` — the top date, plus everything tied with it.
- `organiser_picks` — returns nothing, because under that rule there is no
  computed winner at all, only a preselection of none.

It is its own PR because it is the one place in phase 4 where a judgement is
encoded — what "winning" means — and that deserves to be read on its own rather
than skimmed on the way to a permission check. It is also the piece `p4/17`
reuses without touching anything else Canonise does.

*Tests*: `test/win-rule.test.ts` — a table across the four rules: under
threshold, exactly at it, a three-way tie under `best_available`,
`organiser_picks` returning an empty set however the tallies land, and a roster
of zero not dividing by zero.

*Review focus*: that ties are returned whole. A rule that quietly takes the first
of several tied dates is a rule that decides something the organiser should.

### 7. `p4/7-canonise` — the rule proposes, the organiser disposes · #35

`src/polls/canonise.ts`, and it is two clicks because "winning" is the
organiser's call.

**Canonise** (`o1:poll:canon:<pollId>`) checks the clicker — the poll's
`opened_by`, or a member holding the role id at a new
`SETTING_KEYS.organiserRoleId` (`"discord.organiser_role_id"`, in the same shape
as `schedulingChannelId`), read off the signed `interaction.member.roles` the
interaction already carries. No `guilds` scope, no extra REST call. A
non-organiser gets an ephemeral refusal and no write. An organiser gets
`UPDATE_MESSAGE` rewriting the poll post into an override view: a select of the
dates (`o1:poll:pick:<pollId>`) with the computed winners preselected, and an
**Apply** button (`o1:poll:apply:<pollId>`).

Apply writes `poll_dates.outcome` — `won` for the applied set, `lost` for
everything else, never left `open` — sets `date_polls.status = 'closed'`, and
rewrites the message once more into a closed post with no components. Both writes
are `UPDATE_MESSAGE` answering a click that came from that message.

The function is split deliberately: `applyOutcomes(env, pollId, wonIds)` does the
writing and returns the rows, and the caller renders the response. `p4/17` calls
the first half from inside a *select* interaction and renders the closed post as
that click's own response, so this seam is load-bearing rather than tidy.

What happens *next* — moving a session, minting game days — is not here. This PR
ends at outcomes written and the poll closed. Both consequences hang off it.

*Tests*: `test/poll-canonise.test.ts` — a non-organiser gets an ephemeral refusal
and nothing is written; the opener passes the check without the role; the
override survives, so applying a date the rule did not pick marks it `won` and a
date the rule did pick marks it `lost`; a second Apply on a closed poll changes
nothing; the closed post has no components.

*Review focus*: the role check reads the interaction's own signed payload and
nothing else. And that Canonise is inert for everyone else — the button sits on a
post the whole server can see, so that check is the only thing between a player
and closing a poll.

### 8. `p4/8-poll-close` — a notice, and a post that stops answering · closes #35

A `poll.close` job kind in `src/jobs/drain.ts` — already named in that file's
list of kinds waiting for their phase — plus `armPollClose` in
`src/polls/schedule.ts`, which the two opening paths will call when they arrive.
When the job runs it posts a **new** notice in the poll's `discord_channel_id`
naming the tallies and asking the organiser to canonise. It never touches the
poll post: there is nothing to edit, and no code path here that could.

Which leaves the other half. The post is still sitting there with a live select,
and Orrey cannot disarm it. So `src/polls/respond.ts` learns to refuse a
selection on a poll whose `closes_at` has passed or whose `status` is not `open`,
with an ephemeral "this poll has closed". The handler is where closing is
enforced, because the message is not a place state can live.

Canonise stays available after `closes_at`. Closing the answers is not closing
the poll.

*Tests*: `test/poll-close.test.ts` — the drain posts exactly one notice and marks
the job done; a redelivery under the same idempotency key posts nothing further;
a select after `closes_at` writes no row and answers ephemerally; a select on a
`closed` poll does the same; Canonise after `closes_at` still works.

*Review focus*: the notice is a `postMessage` and the only thing in this PR that
talks to a channel. `poll.close` lives in D1 like every other timed job, so it
can be seen, cancelled and re-run — which a queue message cannot.

### 9. `p4/9-parse-dates` — one date per line, in the guild's zone · #36

A modal takes five text inputs and a poll takes ten dates, so the proposal is
**one paragraph input, one date per line**. `src/polls/parse-dates.ts` is the
pure function that reads it: lines in, and either up to ten `starts_at`/`ends_at`
pairs — the duration copied from whatever the poll is about — or the lines it
could not read, named back verbatim.

The zone comes from `SETTING_KEYS.timezone`, passed in as an argument like every
other ambient value in this repo's pure functions. Unix seconds are UTC; a person
typing "Thu 7pm" means 7pm where they play, and the two are not the same number
on the two Sundays a year when the offset moves.

It is its own PR because it is the only part of #36 that is pure, it is the part
most likely to be wrong, and folding it into the modal would put a date parser
and an interaction handler in one review.

*Tests*: `test/parse-dates.test.ts` — ten good lines parse; an eleventh is
rejected with the count named; a garbled line comes back verbatim and the good
lines around it still parse; blank lines are skipped rather than failing; a date
on each side of a DST transition lands at the wall-clock time asked for, not an
hour off; a line in the past parses, because refusing it is a policy decision and
not the parser's.

*Review focus*: nothing in here reaches for the clock or the database. The
unparseable lines are returned, not swallowed — somebody typed them.

### 10. `p4/10-reschedule` — autocomplete a session, open a poll · #36

The command that has been answering "Date polls arrive in phase 4" since phase 0
starts working. `APPLICATION_COMMAND_AUTOCOMPLETE` in
`src/discord/interactions.ts` — which today returns an empty choice list — is
filled in from `src/polls/autocomplete.ts`: upcoming sessions across the
campaigns the caller is on the roster for, 25 at most, the session id as the
value.

Choosing one and submitting the command opens the paragraph modal, its
`custom_id` minted the same way everything else is and carrying the session
through the round trip. `MODAL_SUBMIT` parses the lines with `p4/9`, and on a
clean parse `src/polls/open.ts` writes the poll and its dates, arms `poll.post`
to run immediately and `poll.close` for `closes_at`, and answers ephemerally. On
a dirty one it answers ephemerally with the lines it could not read and writes
nothing, so nobody retypes nine good dates because of one bad one.

A second open poll for the same session is refused by the partial unique index
from `p4/1`: `openPoll` catches the constraint failure and answers with a pointer
to the poll already open. The check is not "select, then insert" — that races
with itself, which is what the index is there to stop.

No change to `src/discord/commands.ts`. `/reschedule` is already registered with
an autocompleting `event` option, and the surface is still four commands.

*Tests*: `test/reschedule.test.ts` — autocomplete offers only sessions the caller
is rostered on, and caps at 25; the modal submit creates the poll, its dates, and
both jobs; a submit with two unreadable lines writes nothing and names both; a
second submit for the same session is refused by the constraint and creates
nothing.

*Review focus*: the refusal comes from the index, not from a prior read. And the
autocomplete handler answers with one D1 query inside Discord's budget — it fires
on every keystroke.

### 11. `p4/11-suggest-a-day` — the same modal, from the post it concerns · #36

`buttons()` in `src/attendance/render.ts` gains a second action row — In / Out /
Maybe / Note / Refresh is already five, which is Discord's limit per row —
holding **Suggest another day**, minted by a shared helper in
`src/polls/buttons.ts` as `o1:suggest::<sessionId>`. The jeopardy notice from #29
renders the same helper, so there is one mint and one handler for both.

The click opens the modal from `p4/10` with the session already decided, so the
two entry points converge on one `MODAL_SUBMIT` path and one `openPoll`. A click
on a session that already has an open poll gets the same ephemeral refusal
`/reschedule` gives, from the same constraint.

*Tests*: `test/suggest-a-day.test.ts` — the button renders in a second row and
its id decodes to the session; clicking opens the modal and writes nothing; the
jeopardy notice carries the identical id; `test/attendance-post.test.ts` grows
the two-row assertion.

*Review focus*: that adding the row did not disturb the five ids already on the
first. An attendance post minted before this PR has no Suggest button and must
keep working — its other five ids are unchanged, which is the whole reason the
ids are namespaced and versioned.

### 12. `p4/12-move-session` — the event that cannot be moved · #36

Canonising a poll that has a `target_session_id` moves the session.
`src/polls/move.ts`, dispatched from the Apply path in `src/polls/canonise.ts`:
write the winning date onto `sessions.starts_at`/`ends_at`, post a reschedule
notice as a **new** message in `sessions.thread_id` (#27), and arm
`session.project` so both surfaces re-project. Google updates in place — the id
is minted from the session id by `src/google/event-id.ts`, so a moved session
lands on the same event, and the fingerprint moving is what makes the write
happen at all.

Discord is the half that cannot be updated in place. `COMPLETED` and `CANCELED`
are terminal and fire on their own, so an event whose old start time has passed
cannot be PATCHed to a new one. Two things handle it: the move clears
`discord_event_id` **and** `discord_event_fingerprint` when the old `starts_at`
is in the past, so `upsert` in `src/discord/events.ts` takes its create branch;
and `src/discord/rest.ts` learns `isLapsedEvent` beside `isUnknownEvent`, so a
terminal-status rejection at PATCH time mints a replacement rather than retrying
into the DLQ. The stored id was always disposable — `p1/4`'s review note said so,
and this is the PR that spends it.

Carrying the players over is the next PR. This one moves the date and the two
projections that show it.

*Tests*: `test/session-move.test.ts` — canonising a targeted poll writes the new
times and posts one notice in the thread; the old times are gone from D1, not
shadowed; a poll with no winner moves nothing. `test/discord-event.test.ts` grows
two cases: a past session's move creates a new event and stores the new id, a
future session's move modifies the existing one. `test/gcal.test.ts` grows one:
the projector updates the same event id and never inserts at a second.

*Review focus*: the notice is a new message in the thread, and nothing in this
path edits the attendance post or the poll post. And that clearing the Discord id
is the one place an id is dropped deliberately — the fingerprint must go with it,
or the next upsert skips the write it needs to make.

### 13. `p4/13-carry-over` — the available players, onto the new date · closes #36

The last step of a move, and the thing Hermuz's `surveys` proved worth keeping:
everyone who marked the winning date available gets `attendance.intent = 'in'` on
the moved session.

The old intents referred to the old date, so they are cleared first and the
available voters written `in` afterwards — a stale "out" about a Tuesday is not
an answer about a Thursday. The move also clears `sessions.discord_message_id`,
which is what lets `postAttendancePost` send a fresh post instead of returning
the stored id, and the `session.post-attendance` job arming it targets the
thread. The old post stays clickable and stays correct: it renders from D1, so a
click on it rewrites it to the new date.

*Tests*: `test/carry-over.test.ts` — three people available on the winning date
and one available only on a losing date produce three `in` rows and one cleared
row; someone who never answered the poll is untouched; the fresh attendance post
is a new message and the old id is not reused; running the Apply path twice does
not produce a second post.

*Review focus*: clearing `discord_message_id` is a deliberate forget, not a
reconcile — Orrey is not tracking two posts, it is tracking the newest one. And
that the carry-over writes `intent` only. `attended` belongs to #31 and nothing
here may set it.

### 14. `p4/14-untargeted-open` — a game, a kind, and a threshold · #37 · forks off `p4/10-reschedule`

The other use of the same mechanism: a poll with no target, which is what
date-finding for the whole server actually is.

It forks off the reschedule PR rather than off the trunk because both of #37's
ways in are the ones `p4/9` and `p4/10` already built. `src/polls/open.ts` grows
an untargeted branch: `game_id` and `game_day_kind` are required, and the default
`win_rule` is derived from them — `min_players`, threshold from the game's
minimum player count (`games`, #21) — with `quorum_of_roster`, `best_available`
and `organiser_picks` selectable instead. Two entry points, neither of them a
fifth command: a form in the console (#25) posting to a route on
`src/http/app.ts`, and a synthetic "find a new day" choice in `/reschedule`'s
autocomplete, offered only to a caller holding `SETTING_KEYS.organiserRoleId`,
which opens the same paragraph modal with no session attached.

The partial unique index does not constrain these: it is scoped to non-null
targets, so a server can have several untargeted polls open at once, and often
will.

Canonise still stops at outcomes. What a winning date *becomes* is the next PR.

*Tests*: `test/untargeted-poll.test.ts` — opening without `game_id` or
`game_day_kind` is refused with the reason named; the default threshold comes
from the game row and not from a constant; an explicit `win_rule` overrides the
default; two untargeted polls open at once and neither refuses the other; the
autocomplete choice is absent for a caller without the role, and present for one
with it; the console route rejects an unauthenticated post.

*Review focus*: the command surface is still four. If opening a poll here seems
to want its own command, that is the console needing a page — which is what it
got.

### 15. `p4/15-mint-game-days` — one day per winning date · #37

Canonising an untargeted poll mints one `game_days` row per winning date — state
`PROPOSED`, kind from the poll, title from the game — writes
`poll_dates.game_day_id` on each, and arms a `gameday.announce` job per day. The
drain posts one announcement per game day to `SETTING_KEYS.schedulingChannelId`,
as new messages. A multi-kind poll can win more than one date, and then this is
more than one day, which is the case #37 is written around.

Minting happens inside the same `applyOutcomes` transaction that writes the
outcomes, so a poll cannot end up closed with winners and no days. A second Apply
on a closed poll is already refused by `p4/7`, which is what stops a second
Saturday appearing.

Seating is not here. A `PROPOSED` day has no capacity, no host and no signup
buttons — those are phase 5, and the announcement says only that the day exists.

*Tests*: `test/mint-game-days.test.ts` — two winning dates mint two days and arm
two announcement jobs; each `poll_date` points at the day it minted; a poll with
no winner mints nothing and still closes; a redelivered announcement job posts
once; a targeted poll takes the move path and mints nothing.

*Review focus*: the announcement is send-only and its message id is not stored,
because nothing will ever reconcile it. And that the outcome write and the mint
are one path — a reviewer should be able to see there is no window where one
landed without the other.

### 16. `p4/16-forming-anchor` — a winning date that is an anchor · closes #37

The "find the slot" case. An untargeted poll opened against a `FORMING` campaign
carries its `campaign_id`, and canonising it writes the winning date to
`campaigns.recurrence_anchor` (#23) instead of minting anything. The horizon
materialiser takes it from there on the next hourly tick and the campaign's first
sessions appear without anyone entering a date.

One winner only: an anchor is a single date by definition, so a rule that returns
ties resolves in the override view — the organiser picks one — rather than the
code silently taking the first.

No new schema. `recurrence_anchor` is phase 2's column and this is the second
thing that writes it.

*Tests*: `test/forming-anchor.test.ts` — canonising sets the anchor and mints no
`game_days` row; a materialiser run afterwards produces the sessions the anchor
implies; applying two dates at once is refused and the poll stays open; a poll
carrying a `RUNNING` campaign still mints days, because a running campaign
already has its slot; a poll with no `campaign_id` mints days as before.

*Review focus*: which branch a poll takes is decided by the campaign's state and
nothing else, and a poll cannot take both. The anchor may sit in the past by
design — phase 2's recurrence is anchor plus interval — so nothing here may
reject a winning date for being early.

### 17. `p4/17-auto-resolve` — opt-in, and never past the GM · closes #38 · forks off `p4/8-poll-close`

It decides *when* Canonise runs and never *how*, so everything it reads —
`src/polls/respond.ts`, `src/polls/win-rule.ts`, `applyOutcomes` in
`src/polls/canonise.ts` — is on the trunk beneath it, and none of #36 or #37 is.
An earlier draft of this plan sat it on top of the whole reschedule chain, which
serialised it behind five PRs it does not read a line of.

`campaigns.auto_resolve_polls` (integer, default 0) and its migration arrive
here, because this is the PR that reads it, plus the checkbox on the campaign
form in the console (#25). It is read live off the poll's `campaign_id` rather
than copied onto the poll at open time — the opening paths are on another fork,
and an admin who turns the flag off expects the next click to respect that.

In `src/polls/respond.ts`, after the selection is written and before the
re-render, `src/polls/auto-resolve.ts` asks three questions: is the poll's
campaign opted in, does `src/polls/win-rule.ts` now call a date won, and has the
campaign's GM — the `campaign_members` row that says so — marked that same date
available. Only all three together call `applyOutcomes`, so the outcomes and the
closed post are the ones a human click produces. Two of three, and the poll waits
for the organiser.

The person who crossed the line gets the closed post as their own
`UPDATE_MESSAGE` response — the select click renders whatever state it just
produced, which is why `p4/7` split the writing from the rendering.

What a closed poll then *causes* is the use-lines' business and is tested there.
This PR asserts the moment, not the consequence.

*Tests*: `test/auto-resolve.test.ts` — the click that crosses the threshold on a
date the GM has not marked available writes the response and nothing else; with
the GM available, the same click closes the poll and writes the outcomes; an
opted-out campaign never resolves however the tallies land; a poll with no
campaign never resolves; the clicker's own response is the closed post.

*Review focus*: the GM gate, which is the whole point of the issue — a threshold
crossed by five players on a night the GM cannot make is not a win. And that
auto-resolution runs inside the `PollLock` chain, so the click that crosses the
line is the click that renders the closed state.

## Landing order

Bottom-first through the trunk: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. That is the whole
of #34 and #35, and nothing above it can be reviewed against half of it.

After `p4/8-poll-close` lands there are two things in review at once: the
reschedule line (9 → 10) and `p4/17-auto-resolve`, which can merge at any point
after 8. After `p4/10-reschedule` lands there are three: 11 → 12 → 13 on the
targeted side, 14 → 15 → 16 on the untargeted one, and 17 still. Within each
line, bottom-first; between them, any order. After each merge,
`npm run stack -- restack p4 --apply` and `npm run stack -- push p4 --apply`.

Two forks, so tell the tooling twice when the branches are cut, or the next
restack flattens both back into one line:

```sh
npm run stack -- base p4/14-untargeted-open p4/10-reschedule
npm run stack -- base p4/17-auto-resolve p4/8-poll-close
```

`p4/14` forks off `p4/10` rather than off the trunk on purpose. Both of #37's
ways in are the autocomplete handler and the date parser that #36 builds, and
pretending otherwise would produce a branch that does not typecheck on its own.
The parallelism that matters survives: six PRs across two issues are in review
together once `p4/10` is in.

Three conflicts are expected where the forks rejoin, all the shape of phase 1's
`switch` in `src/queue/consumer.ts`, and all resolved by keeping both branches:

- the Apply dispatch in `src/polls/canonise.ts` — a targeted poll moves a session
  (`p4/12`), an untargeted one mints days (`p4/15`);
- the job-kind switch in `src/jobs/drain.ts` — `gameday.announce` from `p4/15`
  against whatever the targeted line has added;
- `src/polls/respond.ts` — `p4/17` hooks in after the write, and the targeted
  line does not touch that function, so this one should conflict on context only.

Phase 4 has no ops issue. #34–#38 are all code and the stack ends at the last of
them. The convention still holds where it applies — #20 and #26 are closed with
what happened in the world, never with a PR — but nothing in this phase is closed
that way.
