# Phase 7 as a stack

The plan for cutting [#9](https://github.com/alxjrvs/orrey/issues/9) — issues
#46–#49 — as fourteen stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 7 is three unrelated pieces of work that happen to be last: logs, stats,
and the Google return path. Nothing in the return path reads `session_logs`;
nothing in the stats reads either of the other two. So the phase is not a line
and it is not one line with forks — it is **three lines sharing a namespace**,
forked off one base. Hanging the stats and the return path off the logs
migration would buy nothing but a shared rebase: neither reads a column that
migration adds, and a day of review on `p7/1` would hold up the largest issue in
the phase for no reason. Three forks cost one thing — the tooling has to be told,
because it infers the parent from the ordinal — and `npm run stack -- base` is
what it is for.

## Where it roots, and why not `main`

**`p7/0-base`, a merge of phase 6's tips** — the same shape `p6/0-base` has for
phase 5's, one level up. Not `main`.

This is worth stating first because the phase-6 plan got it wrong in exactly this
way, and the divergence is recorded in `docs/PHASE-6-STACK.md`: it made the ICS
lane "a second root off `main`" on the reasoning that nothing in the feed reads
the console. The reasoning was right and the conclusion did not follow, because
`main` is **phase 1** and the feed needed `signups` and `game_days`, which are
phases 2 and 5. The same trap is set here three times over:

- `p7/2-recap` checks the author against `campaign_members` (#21, phase 2) and
  hangs its button on the correction post (#31, phase 3).
- `p7/4` reads `campaign_members` and phase 3's tri-state `attendance.attended`;
  `p7/5` reads `audit_log` (#21); `p7/6` reads `signups`, `game_days` and
  `attendance.tables_played`, which are phases 4 and 5; `p7/7` is two console
  pages, and the console's shell is phase 2 and its shape is phase 6.
- `p7/12-inbound-change` moves a session, and the domain move is phase 4.

`p7/8-watch-channels` genuinely could root at `main` — it needs only
`src/google/calendar.ts` and the `watch-renew` cron slot, both phase 1 — and it
is rooted on the base anyway. A lane whose bottom sits on a different commit from
its top is a lane that conflicts with itself at the first restack, and the
independence the three lines actually need is independence *from each other*, not
from the phases below them all.

The return path is six of the fourteen. It is the only loopable edge in the
system, and each PR exists so that one more part of the loop is provable before
the next part can close it: the channel before the webhook, the webhook before
the list, the list before the classifier, the classifier before anything writes
to `sessions`, the write before the delete path, the nightly sweep last because
it is the same classifier on a different trigger. Six PRs for one issue is more
than the two or three the skill describes as usual, and the reason is the line
limit rather than taste: #48 has six checkboxes and about 1,700 lines in it, and
the classifier alone — the thing that decides whether Orrey is looking at its own
handwriting — deserves a review nobody is reading past. The echo test is the
whole phase, and it cannot be written until `p7/12`.

```
p7/0-base  (merge of phase 6's tips)
 ├── p7/1-session-logs (#46)
 │    └── p7/2-recap (#46)
 │         └── p7/3-logs-on-the-page (#46)
 ├── p7/4-campaign-attendance-stats (#47)
 │    └── p7/5-campaign-schedule-stats (#47)
 │         └── p7/6-game-day-stats (#47)
 │              └── p7/7-stats-pages (#47)
 └── p7/8-watch-channels (#48)
      ├── p7/9-webhook (#48)
      │    └── p7/10-sync-list (#48)
      │         └── p7/11-classify (#48)
      │              └── p7/12-inbound-change (#48)
      │                   └── p7/13-deleted-and-reconcile (#48)
      └── p7/14-probe (#49)          ← forks off p7/8
```

## The slices

### 1. `p7/1-session-logs` — one table, and one way to write to it · #46

`src/db/schema.ts` gains `session_logs` and the generated migration: `id`,
`session_id` (references `sessions`, `ON DELETE cascade`), `author` (references
`users.discord_id`), `body`, `created_at`, and an index on
`(session_id, created_at)`. Exactly the four columns #46 names. No `kind`
column: in this phase a recap is the only thing that writes here, and the day a
reschedule notice wants to be logged too is the day that column is worth
arguing about.

`src/logs/session-log.ts` holds both directions — `addSessionLog(env, {
sessionId, authorId, body })` and `sessionLogs(env, sessionId)`, ordered by
`created_at` then `id`, because `created_at` is `unixepoch()` seconds like every
other timestamp in `src/db/schema.ts` and two writes in the same second must
still come back in the order they were made. `normaliseLogBody` is the
counterpart to `normaliseNote` in `src/do/session-lock.ts` and differs from it
in one way that matters: a recap keeps its newlines. A note is rendered inline
on a post Orrey cannot edit; a recap is a message of its own.

`src/privacy/delete.ts` gains `session_logs`. It is user-keyed through `author`,
so it belongs on the receipt — the rule that file states is that every phase
adding a user-keyed table adds its delete there, and this is that phase.

This is the root of the logs line and of nothing else. Neither the stats line
nor the return path reads `session_logs`, so neither is based here.

*Tests*: `test/session-log.test.ts` — two logs written in the same second come
back in write order; deleting the session takes its logs; a body's newlines
survive and its trailing whitespace does not; `test/privacy.test.ts` gains a
case where the receipt counts `session_logs (n)` rather than silently cascading
them off the user row.

*Review focus*: four columns, no fifth. The ordering is deterministic without
relying on rowid. And the privacy delete — a user-keyed table that lands without
a line in `deleteUserData` is a delete-my-data path that quietly lies.

### 2. `p7/2-recap` — one writer, and the first of its two doors · #46

`src/logs/recap.ts` is the whole of what a recap is: check that the author is a
GM of that campaign against `campaign_members` (phase 2, #21), normalise and
store the row through `addSessionLog`, then post a **new message** into
`sessions.thread_id` through `throughGovernor` and `postMessage` from
`src/discord/rest.ts`, falling back to the campaign channel for a session old
enough to have no thread. It is written as a shared function now, with one
caller, because #46 names two doors into this and the second arrives one PR up.
Writing it inside `handleModal` and lifting it out later is the same code and a
worse review — the reviewer of the second door would have to read a move and a
feature at once.

The door this PR builds is Discord's. The correction post phase 3 builds (#31)
gains a *Recap* button; `src/discord/interactions.ts` gains a `recap` action in
`handleComponent` and a `recap` branch in `handleModal`, both minted and parsed
through `src/discord/custom-id.ts` like everything else, so a click on last
month's post degrades to the retired-post response rather than "interaction
failed".

The modal is a paragraph-style text input, not prefilled — unlike the note
modal, which is prefilled because an empty box there means "clear it". Here an
empty box means nothing was written, and there is nothing to clear: a recap is
appended, never replaced. Submitting twice is two rows, and that is correct. A
non-GM is refused ephemerally and nothing is written.

The interaction answers ephemerally. The recap is a new post in the thread, not
a rewrite of the correction post, so there is nothing for `UPDATE_MESSAGE` to
do. The posted body goes through `escapeMarkdown` from
`src/attendance/render.ts` and carries
`allowed_mentions: { parse: [], roles: [] }`.

*Tests*: `test/recap.test.ts` — the modal id round-trips through
`decodeCustomId`; a non-GM submission is refused and `session_logs` is empty
afterwards; the stored body and the posted body are the same text, escaped only
on the way out; the posted call is a POST to `/channels/:id/messages` and there
is no PATCH anywhere in the transcript; two submissions leave two rows; a
session with no `thread_id` posts to the campaign channel instead.

*Review focus*: the thread post is a new message and the response is ephemeral —
nothing in this PR is reachable from a cron, a projector or the console, which
are the three things that must never touch a posted message. A recap is somebody
else's text on a post Orrey can never edit: escaped, and with mentions disarmed.

### 3. `p7/3-logs-on-the-page` — the console reads the log, and writes one through the same door · closes #46

#46's remaining half: the read side, and the second door.

The session-detail route phase 6 adds (#43) returns `sessionLogs` oldest-first;
the campaign page (#44) returns the campaign's logs across its sessions, each
under the session it belongs to. The `public/` pages render them in order with
the author's cached name from `users` — a cache, as `src/db/schema.ts` says, so
a missing name renders as the id rather than as an empty line.

The second door is a recap form on the session-detail page, posting to a console
route that calls `postRecap` from `src/logs/recap.ts` **unchanged**. No new logic
and no second path: the GM check, the normalisation, the row and the thread post
are the ones `p7/2` shipped. The failure this avoids is a console recap that
lands in D1 and never reaches the thread, which is the thing this phase is least
likely to notice and most likely to ship.

*Tests*: `test/console-logs.test.ts` — logs come back oldest-first and grouped by
session on the campaign page; the console route refuses the same non-GM the
modal refuses, because it is the same check; a console recap posts exactly one
message to the thread, asserted on the fake fetch, so the shared path is proved
rather than assumed.

*Review focus*: one writer, two doors — a diff that adds a store or a post
outside `src/logs/recap.ts` is the finding here. Reading logs requires the
console session (#24); a log belonging to a campaign the reader is not on is
still readable, because the console is administration and its audience already
sees everything.

### 4. `p7/4-campaign-attendance-stats` — what the attendance rows already say · #47 · forks off `p7/0-base`

**No schema, and no cache.** Every number #47 asks for is derivable from rows
phases 2–5 already write, and nothing here stores a result — these are read at
request time from a database with hundreds of rows in it. This is the root of
the stats line: it reads no table phase 7 adds, so it forks off the base rather
than off the logs line.

The first checkbox of #47 splits at the seam between its source tables, and this
is the half that comes out of `sessions` and `attendance`.
`src/stats/campaign.ts`, split the way `src/attendance/render.ts` is split:
`computeCampaignAttendance(rows)` is pure and takes no clock,
`loadCampaignAttendance(env, campaignId)` does the queries.

Sessions played is `sessions.state = 'PLAYED'` — not "in the past", which is a
different question and a wrong answer for a session nobody has corrected yet.
Attendance rate per member is `attendance.attended` over the sessions played
since that member joined, which `campaign_members` (#21) records, so someone who
joined at session 20 is not rated on the first nineteen. Streaks are consecutive
played sessions attended, broken by an absence and not by a cancellation — a
session nobody could attend says nothing about anybody.

*Tests*: `test/stats-campaign.test.ts` — a member who joined mid-campaign is
rated over the sessions since they joined; a `CANCELLED` session counts for
nobody's rate and breaks nobody's streak; a member with no played sessions behind
them has a null rate rather than `NaN` or a confident zero; `attended = null`
(nobody corrected it, the auto-assume never ran) is neither present nor absent
and is excluded from both ends of the fraction.

*Review focus*: every division has a defined answer at zero, and `null` for "not
applicable" is a different value from `0`. `PLAYED` is the definition of played.
And `attended` is tri-state in `src/db/schema.ts` — a stat that reads it as a
boolean is reading an unanswered session as an absence.

### 5. `p7/5-campaign-schedule-stats` — most-rescheduled and lead time, out of the audit trail · #47

The other half of #47's first checkbox, and the half that reads `audit_log`
(#21) rather than the domain tables — which is why it is a separate review: the
question is no longer "what do the rows say" but "do these two audit kinds mean
what the stat claims they mean".

Most-rescheduled counts the `audit_log` rows of the kind that says a session
moved, per session, and names the top of that list. Average lead time to quorum
is the gap between `sessions.created_at` and the `audit_log` row phase 3's
auto-confirm writes (#28); a session that never reached quorum is excluded from
the average rather than counted as zero, because a session nobody confirmed has
no lead time, not a lead time of nothing.

Both kinds are the constants in `src/db/audit.ts`, read and never re-spelled.
`p7/12-inbound-change` writes the move kind from the other line of this phase,
and a stat that matches on a string literal would silently stop counting the day
that spelling changes.

*Tests*: `test/stats-schedule.test.ts` — a session moved three times outranks one
moved twice; a session that never confirmed is absent from the lead-time
average, and the average of none is null rather than zero; a campaign with an
empty `audit_log` returns nulls in every field and throws nowhere.

*Review focus*: the audit kinds come from `src/db/audit.ts`. Excluded and zero
are different answers, and the page above has to be able to tell them apart.

### 6. `p7/6-game-day-stats` — fill rate, waitlist depth, and the tables that formed · #47

`src/stats/game-day.ts`, the same shape as the campaign half: a pure compute over
rows, a loader beside it. Fill rate is seated signups over the day's capacity.
Waitlist depth is the number of signups in the waitlist state at the point the
day locked (#40). Tables played comes from `tables_played` (#39) and is a
multi-day-only number (#42).

The two kinds of game day answer differently, and that is the PR: a `multi` day
is seated at the day level and has no capacity of its own, so its fill rate is
**null**, not zero and not one. A `single` day (#41) that nobody signed up for
has a fill rate of zero, which is a real answer. Anything that flattens those two
into one number is the bug this file exists to avoid.

*Tests*: `test/stats-game-day.test.ts` — a multi day has a null fill rate and a
single day with an empty roster has a zero one; waitlist depth counts the
waitlist as it stood at LOCK and not as it stands now, so an auto-promotion does
not erase the fact that there was a queue; a day with no tables recorded reports
none rather than zero tables; a `CANCELLED` day reports nothing at all.

*Review focus*: null versus zero, in every field, including the ones the page
will average across days. Nothing here reads `games` for a capacity the day
already copied — capacity is the day's column.

### 7. `p7/7-stats-pages` — two console pages, and nothing reaches Discord · closes #47

`src/http/console/stats.ts` — a campaign-history route and a game-day route, both
behind the console session (#24) — plus the two `public/` pages that render them:
per-member attendance and streaks beside most-rescheduled and lead time on the
campaign page, fill rate and waitlist depth per day on the other.

#47's third checkbox says "nothing posts to Discord", and this is the PR where
that could stop being true: a stats page is exactly the kind of thing someone
later wants a weekly summary post for. It stays four commands, nothing here
enqueues anything, and nothing here calls Discord at all.

*Tests*: `test/console-stats.test.ts` — both routes require the console session
and 401 without it; the numbers a page returns are the ones the three compute
functions produce for the same fixtures, so each route is proved to be a view and
not a second implementation; a request to either route leaves the outbox empty
and makes no call to `postMessage`, asserted rather than reasoned about.

*Review focus*: read-only in the strict sense — no writes, no queue messages, no
Discord calls. And the pages are pages: a number a person has to interpret
belongs next to a sentence saying what it counts, because "attendance rate 0.62"
and "missed five of thirteen" are read very differently by the person they are
about — and a null renders as "not enough played yet", never as a dash the reader
has to guess at.

### 8. `p7/8-watch-channels` — open a channel on the Orrey calendar, and keep it open · #48 · forks off `p7/0-base`

The first half of the return path's plumbing, with nothing listening at the other
end yet. This is the root of the return-path line: it reads nothing phase 7 adds
elsewhere, so it forks off the base. It is the one slice in the phase that could
honestly have sat on `main` — it needs only `src/google/calendar.ts` and the
`watch-renew` cron slot, both phase 1 — and "Where it roots" above says why it
does not.

`src/google/watch.ts` holds `startWatch`, `stopWatch` and `renewWatchIfDue`, all
going through `accessToken` from `src/google/calendar.ts`: a
`POST /calendars/{id}/events/watch` with a generated channel `id`, a generated
`token` that is the channel's shared secret, and an `address` built from a new
`PUBLIC_ORIGIN` var — added to `src/env.ts` and `wrangler.jsonc`, because the
cron has no request to take an origin from the way `src/http/app.ts` does.

The channel's id, resource id, token and expiry live in `settings` under a new
`SETTING_KEYS.googleWatch`, because there is exactly one calendar and #48 says
so. `src/cron/scheduled.ts` already fires `watch-renew` at 04:00 UTC and carries
the comment explaining why; this PR gives it a body. Open a channel when there is
none, renew when the stored expiry is inside 48 hours, and **stop the old channel
only after the new one is recorded**. Overlapping channels mean duplicate pushes
for a few minutes, which the sync path collapses anyway; a gap means changes
nobody hears about.

What is deliberately not here: anything that receives a push. The route arrives
one PR up, which means the first channel opened against production will push into
a 404 until then — harmless, and better than a route with no channel behind it to
test against.

One prerequisite lives outside the repo: Google refuses to deliver push
notifications to an unverified domain, so the Worker's public hostname has to be
verified once in the Google console before a real channel can be opened. That is
not code and no test can stand in for it.

*Tests*: `test/google-watch.test.ts` — a channel inside the renewal window is
replaced and the old one stopped, in that order, asserted on the call transcript;
a channel with a week left is left alone; a `stop` that fails leaves the new
channel recorded, because the write comes first; the renewal is idempotent when
the tick runs twice in a minute.

*Review focus*: the watch is opened on `GOOGLE_CALENDAR_ID` through the same
`calendarId(env)` rule `src/google/calendar.ts` states, and there is no code path
here that takes a calendar id from anywhere else — the user's Social calendar is
not reachable from this file. The channel token is a secret and appears in no log
line.

### 9. `p7/9-webhook` — the push carries no body, so it arms a job · #48

`src/http/app.ts` gains `POST /google/notifications`, above the `app.all("*")`
asset fallback. It reads `x-goog-channel-id` and `x-goog-channel-token`, compares
both against the `settings` row `p7/8` writes, and answers 404 to anything that
does not match — 404 rather than 401, because a 401 confirms the channel exists
to whoever guessed the URL. `x-goog-resource-state: sync` is the handshake Google
sends when the channel opens: acked and ignored.

Anything else arms a `gcal.sync` job in D1 and returns 200 immediately. A job,
not a queue message, for the reason the `jobs` table exists at all: this is the
trigger for the one path in the system that can loop, and it has to be
inspectable and re-runnable by hand. The idempotency key is `gcal.sync:<minute>`,
so a burst of pushes — which a single drag in Google produces — collapses into
one sync by the unique constraint on `jobs.idempotency_key` rather than by a
lock. `src/jobs/drain.ts` gains the `gcal.sync` kind, dispatching to a function
that does nothing yet, so an armed job drains rather than throwing
`unknown job kind`.

The handler never reads the request body. Google's push has none, and the day it
does, it is still a signal and not data: the source of truth for what changed is
the list call, not the notification.

*Tests*: `test/google-webhook.test.ts` — a wrong token is 404 and arms nothing; a
missing channel id is 404; a `sync`-state push arms nothing; ten pushes inside
one minute leave exactly one pending job; the route is matched before the asset
fallback; a drain over the armed job completes and marks it done.

*Review focus*: the body is never parsed, and the job is the only thing the route
produces. Nothing here reaches Google, so a flood of pushes costs one D1 insert
each and cannot become a flood of API calls.

### 10. `p7/10-sync-list` — list the whole calendar, and survive an expired token · #48

The transport, on its own, before anything interprets what it returns.
`src/google/sync.ts`: `listCalendar(env)` calls
`GET /calendars/{id}/events` with the `syncToken` stored in `settings`, pages on
`nextPageToken`, stores `nextSyncToken` when the last page arrives, and returns
the events it collected. The `gcal.sync` job kind `p7/9` left empty now calls it
and does nothing with the result.

A `410 Gone` clears the stored token and starts again from a full list. Google
expires sync tokens on its own schedule, so the recovery has to be ordinary
rather than exceptional — a path with a test, not a log line.

The list carries **no `timeMin`, no `q`, no `privateExtendedProperty`**:
`syncToken` is incompatible with all three, which is the platform constraint that
made Orrey own a calendar in the first place, and #48 says so in as many words.
Listing everything is the design, not a shortcut, and the comment at the top of
this file should say so before someone optimises it.

What is deliberately not here: classification, and any write to `sessions` or
`calendar_links`. This PR knows how to ask Google what is on the calendar and
nothing about what any of it means.

*Tests*: `test/gcal-sync.test.ts` — three pages are collected into one list and
only the final `nextSyncToken` is stored; a 410 clears the token and re-lists
from scratch in the same call; the request URL contains none of the three
incompatible parameters; a run with no stored token lists fully and stores one;
the job drains without touching any other table.

### 11. `p7/11-classify` — know Orrey's own handwriting · #48

The heart of #48, kept to one file and one review. `src/google/classify.ts`:
`classifyEvent(event, link, session)` is pure and returns `echo`, `changed`,
`deleted` or `foreign`.

Finding the session comes first:
`extendedProperties.private.orreySessionId`, which `eventBody` in
`src/google/calendar.ts` already writes, falling back to
`calendar_links.gcal_event_id`. An event with no session behind it is `foreign`
and is left alone — people put things on this calendar too.
`status: "cancelled"` is `deleted`. Otherwise the verdict is a fingerprint
comparison: rebuild the shape `googleProjectedContent` builds in
`src/projection/target.ts`, hash it with `src/projection/fingerprint.ts`, and
compare against `calendar_links.fingerprint`. Equal is `echo`; different is
`changed`.

Four of that shape's five fields come off the event — `title` from `summary`,
`startsAt` and `endsAt` from `start`/`end`, `location` from `location`. The
fifth, `state`, does not exist in Google at all and is taken from the session
row. That asymmetry is the thing to review: it means a Google event can never
*disagree* about state, which is exactly #48's rule that Google never cancels a
session, and it means the recomputed hash still lines up with the one the
projector stored.

What decides is that recomputed fingerprint, **not** the `orreyFingerprint`
extended property `eventBody` writes. A human dragging an event leaves that
property untouched, so trusting it would classify every real change as Orrey's
own echo — the exact failure the phase exists to prevent, arrived at by the more
convenient route. The property stays written, because it is useful when reading
the calendar by hand, and is never read here.

Attendee `responseStatus` is not read anywhere in this file, and #48 says why: it
is not an RSVP and never will be.

The `gcal.sync` job now lists and classifies, and still writes nothing.

*Tests*: `test/gcal-classify.test.ts` — an event matching the stored fingerprint
is `echo`; a moved start time is `changed`; a retyped summary is `changed`; a
cancelled event is `deleted`; an event with no `orreySessionId` and no matching
link is `foreign`; the verdict is identical when every attendee has declined; the
verdict is identical when `orreyFingerprint` is stale or absent.

*Review focus*: the inbound shape and `googleProjectedContent` are the same
fields in the same order, and the two live close enough to read together — they
cannot be allowed to drift, because an echo that stops being recognised is an
infinite loop. Nothing in this PR writes to `sessions`.

### 12. `p7/12-inbound-change` — a GM dragged it, so D1 moves and everything follows · #48

`src/google/inbound.ts` takes what the classifier called `changed`, and splits it
in two — which is the part of this PR worth the most review attention.

**The times or the location moved.** Take that session's `SessionLock` — the same
Durable Object that serialises clicks, because a drag in Google and a click on
the post are two writers to one session — then update `starts_at`, `ends_at` and
`location`, write the `audit_log` row that says the session moved (the constant
in `src/db/audit.ts`, the one `p7/5` counts), post a reschedule notice as a **new
message** into `sessions.thread_id`, and call `enqueueProjection(env,
sessionId)`. The Google projector then rewrites the event with a fingerprint
computed from the new row, so the push that write provokes classifies as `echo`
and stops there. The Discord half goes through `projectDiscordEvent`, whose
`isUnknownEvent` path in `src/discord/rest.ts` already mints a replacement when
the old scheduled event has lapsed — a session moved out of a terminal Discord
status needs a new event, and that code exists.

**Nothing Orrey adopts moved** — somebody retyped the summary. Only the three
fields Orrey projects are taken: the title is derived from the campaign and the
session number, and adopting it would start a fight the projector wins on the
next write anyway. But the naive version of this case never terminates: the row
is unchanged, so `calendar_links.fingerprint` still matches what
`googleFingerprint` computes, so `upsert` in `src/google/calendar.ts` skips the
write, so Google keeps the retyped summary, so every nightly pass classifies it
`changed` again and posts another notice forever. So this branch **clears
`calendar_links.fingerprint`** — the same mechanism the delete path uses one PR
up — which is what makes the next upsert unskippable, re-projects, and posts no
notice and writes no audit row, because nothing moved.

The session state is not taken in either branch. #48 is explicit that Google
never cancels a session.

*Tests*: `test/gcal-inbound.test.ts` — a moved event moves the row, writes one
audit row, posts one notice and enqueues both surfaces; the notice is a POST to
the thread and the transcript contains no PATCH to a message; **the loop
terminates** — apply the change, run the projector, feed the resulting event back
through the classifier, and it is an echo with no further writes; a retyped
summary writes nothing to `sessions`, posts no notice, and the projection that
follows actually issues a Google write rather than skipping, and its echo is
recognised; two pushes for the same change produce one notice.

*Review focus*: the loop terminates, and the two tests that say so are the ones
to read first. The only message write is a POST — there is no interaction here,
so `UPDATE_MESSAGE` is not even in reach, and any edit would be the invariant
broken outright. And nothing reads the Discord message to find out what the
session used to say; the row is the record.

### 13. `p7/13-deleted-and-reconcile` — D1 wins, and the nightly sweep · closes #48

Two things, one idea: D1 wins.

An event the classifier calls `deleted` does not cancel anything. The handler
clears that row's `calendar_links.fingerprint` and enqueues a `gcal.upsert`.
Clearing the fingerprint is the mechanism, not a tidy-up — `upsert` in
`src/google/calendar.ts` skips a write whose fingerprint already matches, so
without the clear the re-insert would be skipped and the event would stay gone.
It comes back at the same id, because `src/google/event-id.ts` mints it from the
session id, so the re-insert is the ordinary `insert`, and on 409 `update`, path.
That is #48's "mark the calendar link as missing and re-insert", and it needs no
column to say so: an absent fingerprint *is* "we do not know what is out there".

Then `src/cron/scheduled.ts`'s `reconcile` case, already firing at 05:30 UTC with
the comment that explains it: a full list with no `syncToken`, every event
through the same classifier and the same handlers this stack already has.
`events.watch` is not 100% reliable — #48 gives that as the reason this exists —
and the nightly pass is what makes an unreliable channel merely slow. It also
finds the opposite failure, which no push can ever report: a session whose
`calendar_links` row names an event that is not on the calendar at all,
re-inserted the same way.

*Tests*: `test/gcal-reconcile.test.ts` — an event a human deleted is back at the
same id after one nightly run, and the session's state never changed; a session
whose link names an event the calendar does not have is re-inserted; **a nightly
run over an untouched calendar issues zero writes** — every fingerprint matches,
and a sweep that rewrites everything every night is a sweep that makes the echo
test meaningless; a `foreign` event is still untouched by the nightly pass; the
push path and the nightly path call the same classifier, asserted by fixture
rather than by reading.

*Review focus*: no direction in which Google wins. The re-insert is at the
deterministic id; the delete path never touches `sessions.state`; and the nightly
pass is a no-op on a quiet day, which is the only thing that makes running it
every night affordable.

### 14. `p7/14-probe` — measure what the watch actually promises · closes #49 · forks off `p7/8`

Forks off `p7/8-watch-channels`, because `startWatch` and `stopWatch` are all it
needs and the rest of the return path is irrelevant to it. Land it as soon as
`p7/8` is in `main`: it is the one PR that can change `p7/8`'s renewal window,
and that is cheaper to do before five PRs are sitting on top of the assumed one.

`scripts/probe-watch.ts`, in the shape of `scripts/prove-gcal.ts`: run by hand
against the real calendar under `op run`, printing statuses and ids and no
secrets.

It does two measurements. First, open a watch channel, print the `expiration`
Google returns and the TTL it implies, then stop the channel — if that is shorter
than seven days, the 48-hour renewal window in `src/google/watch.ts` changes in
this PR, and that change is the point of the probe. Second, insert two events
with different `privateExtendedProperty` values, list with the filter repeated
twice, and print whether the result is the intersection or the union — settling
the contradiction between Google's reference and its guide that #49 names. Then
delete both events.

The answers land in `docs/GOTCHAS.md`, one entry each, in that file's form: the
trap, and the rule it forces. The AND/OR answer changes no code today —
`syncToken` forbids the filter, which is why the sync path lists the whole
calendar — so the entry says that too, and says what it would mean for the day
someone reaches for that filter anyway.

*Tests*: the script is not unit-tested; it talks to Google, which is the whole
reason it exists. What this PR tests is the consequence —
`test/google-watch.test.ts` gains a case at the measured TTL, so an expiry
shorter than assumed is a failing test rather than a channel that lapses one
night.

*Review focus*: the probe cleans up after itself — channel stopped, both events
deleted, even on an error path — and it reads `GOOGLE_CALENDAR_ID` from the
environment like every other Google caller, so it cannot be pointed at a calendar
Orrey does not own. The printed summary goes on #49, and that is what closes it.

## Landing order

Three lines, landed bottom-first and independently: 1 → 2 → 3,
4 → 5 → 6 → 7, and 8 → 9 → 10 → 11 → 12 → 13 with 14 forking off 8 — all three
forked off `p7/0-base`. After every merge into `main`, all three lines need
replaying —
`npm run stack -- restack p7 --apply` then `npm run stack -- push p7 --apply` —
because a push to `main` is what makes `status` say `NEEDS RESTACK`, whichever
line it came from.

The bases have to be recorded the moment the branches are cut, because the
tooling reads the ordinal as the chain and a root it has not been told about is a
root the next restack flattens into the line above it:

```sh
npm run stack -- base p7/1-session-logs             p7/0-base
npm run stack -- base p7/4-campaign-attendance-stats p7/0-base
npm run stack -- base p7/8-watch-channels            p7/0-base
npm run stack -- base p7/14-probe p7/8-watch-channels
```

Land `p7/14-probe` as soon as `p7/8` is in `main`, ahead of the rest of the
return path. It is the one PR that can change `p7/8`'s renewal window, and a
measured window is worth more before five PRs are sitting on top of the assumed
one. Nothing else in the return path touches that constant, so the restack that
follows is clean.

One thing `npm run stack -- restack p7 --apply` will get wrong, learned the hard
way on phase 6: it plans a rebase for **every** branch including `p7/0-base`, and
`p7/0-base` is a *merge*. Rebasing it linearises every commit behind it and stops
on the first conflict. Skip it — it sits on `main` already and has no drift to
correct — and replay `p7/1` upward. `git merge-base --is-ancestor p7/0-base
<branch>` is the cheap check for whether a branch needs replaying at all.

There is no conflict inside the return path: `p7/8-watch-channels` fills in
`watch-renew` and `p7/13-deleted-and-reconcile` fills in `reconcile` in the same
`switch` in `src/cron/scheduled.ts`, but 13 descends from 8, so it is building on
it rather than racing it.

One coupling crosses lines, and it is a string rather than code.
`p7/5-campaign-schedule-stats` counts `audit_log` rows of the kind that means
"this session moved"; `p7/12-inbound-change` writes one. They are in different
lines, so the name lives once in `src/db/audit.ts` where phase 2 put it (#21),
and whichever lands second is the one that has to prove it still matches. If
`p7/12` lands first, most-rescheduled counts Google-originated moves from the day
`p7/5` arrives; if `p7/5` lands first, the number is right and quietly gains a
source later. Neither ordering is wrong, and neither is a reason to serialise the
lines.

Phase 7 has no `ops`-labelled issues. The two still open, #20 and #26, belong to
phases 1 and 2 and are closed with what happened on the day. #49 reads like one
and is not: it is labelled `unverified`, not `ops`, and what closes it is a
measurement against the real API plus whatever that measurement changes in the
code — which is a PR. That is `p7/14-probe`. The measurement happens in the
world; the PR is the record of it, and the printed summary goes on the issue.

One thing in the phase happens outside the repo and outside an issue: Google will
not deliver push notifications to an unverified domain, so the Worker's public
hostname has to be verified once in the Google console before `p7/8`'s channel
can be opened against production. It is not code and it is not a PR; it is a
prerequisite for the first real watch channel, and `p7/8` says so in its body
rather than pretending the tests cover it.
