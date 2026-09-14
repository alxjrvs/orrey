# Phase 6 as a stack

The plan for cutting [#8](https://github.com/alxjrvs/orrey/issues/8) — issues
#43, #44, #45 — as sixteen stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 6 is wider than it is deep. Nearly all of it is one page reading one
query, so the page is the unit of review and the stack is a tree rather than a
line. Three things shape it. One query sits under the agenda, the month grid
and `/upcoming`, so it lands first and alone, and it carries the JSON envelope
six later slices fork off it to get. The ICS feed shares nothing with the
console but the file where routes are registered, so it is a **second root off
`main`** — all three of its PRs, serialiser through console panel, can be
reviewed and landed while the console is still in review. And the console's own
pages fan out: once the session rail exists, the campaign page, the game-day
page, the admin tables, the audit log and delete-my-data have no reason to wait
on each other, so they fork.

Ordinals run depth-first through the tree, not in landing priority.
`p6/14-ics-serialise` is numbered last and is a root; it can be the first thing
in `main`.

Phases 2 through 5 are written but not yet merged, so phase 6 roots off
`p6/0-base` — phase 5's three forks merged into one commit — rather than off
`main`, exactly as `p5/0-base` did for phase 5. That base empties out and closes
on its own as the phases below it land. `p6/14-ics-serialise` is described below
as "a second root off `main`"; in practice it roots off `p6/0-base` too, because
`ics_sequence` has to sit beside the schema phase 5 added. It still shares
nothing with the console but the file where routes are registered, so it can be
reviewed and landed independently of everything above it.

Where a slice below names something phases 2 to 5 own — the console router and
its session gate, the confirm-and-audit shape phase 2's lifecycle actions use,
`campaign_members`, `audit_log`, `games`, `game_days`, the reschedule path — it
now names a path that exists on this base.

```
p6/0-base   (phase 5's three forks merged)
 ├── p6/1-agenda-model (#43)
 │    ├── p6/2-agenda (#43)
 │    │    └── p6/3-session-detail (#43)
 │    │         ├── p6/4-session-actions (#43)
 │    │         └── p6/5-campaign-page (#44)
 │    │              ├── p6/6-campaign-history (#44)
 │    │              ├── p6/7-campaign-polls (#44)
 │    │              └── p6/8-game-day-page (#44)
 │    ├── p6/9-month (#43)
 │    ├── p6/10-games-admin (#44)
 │    │    └── p6/11-settings-admin (#44)
 │    ├── p6/12-audit-log (#44)
 │    └── p6/13-delete-my-data (#44)
 └── p6/14-ics-serialise (#45)
      └── p6/15-ics-routes (#45)
           └── p6/16-feeds-console (#45)
```

## The slices

### 1. `p6/1-agenda-model` — one query behind two agendas · #43

`src/console/agenda.ts`: a half-open window query (`from`, `to`) over `sessions`
joined to `campaigns` and to game days, returning per row the quorum number, the
intent tally — in / out / maybe / no reply, counted against the roster in
`campaign_members` — the session state, and whether jeopardy has been raised.
Plus `GET /console/api/agenda` on the console router behind phase 2's session
gate, in the JSON envelope every later page reuses: `{ asOf, rows }`, because
the console carries the same as-of line the Discord posts do and for the same
reason.

The envelope is a helper rather than a habit, and that is why six slices fork
off this branch instead of off `main`: it is the one piece of phase 6 that
everything above it shares.

`/upcoming` (#33) stops deriving quorum for itself and calls this. That is the
point of doing the model before any page: #43 calls the agenda "the console
counterpart to `/upcoming`", and a counterpart that computes the same numbers a
second way is a counterpart that will disagree with it by phase 7.

A campaign in `HIATUS` contributes nothing, for the same reason `isProjectable`
in `src/projection/target.ts` refuses to publish it — a console that lists an
upcoming session Orrey is not projecting shows the organiser a plan Discord does
not have.

The window is an argument rather than a hardcoded "upcoming" so that
`p6/9-month` can ask for a month, including one that is already past.

*Tests*: `test/console-agenda.test.ts` — the window is half-open, so a session
starting exactly at `to` is excluded; a campaign in `HIATUS` contributes
nothing; "no reply" counts roster members with no `attendance` row rather than
reporting zero; jeopardy is read off `sessions.state` and never recomputed here;
the route answers 401 with no session cookie. `/upcoming`'s existing test passes
**unedited** — that is the proof the extraction moved no behaviour.

*Review focus*: the model is a function of rows and an `asOf` argument, the way
`renderAttendancePost` in `src/attendance/render.ts` is — no `Date.now()` inside
it, so what a page renders is what a test can render. And if the `/upcoming`
test needed touching, the refactor changed something it was not meant to.

### 2. `p6/2-agenda` — the worklist and the record · #43

The agenda page under `public/console/`, drawn from
`design/ui_kits/console/Agenda.jsx`: day-grouped rows using the `DayHeader` and
`SessionRow` treatments, a `QuorumMeter` per row, the By day / Flat toggle, and
the two views the design asserts — *What I'm scheduling*, which carries the only
primary action on the screen, and *What's confirmed*, which carries none. It
reads `GET /console/api/agenda` and nothing else.

The grouping is done on the server against the guild zone, not in the browser
against the viewer's. That is what makes the page testable in a repo with no DOM
harness, and it is also correct: two people in two zones must not see a session
fall on different days.

Deliberately not here: the detail rail (`p6/3`) and the month grid (`p6/9`). A
row can be selected and shows the selection bar the design specifies; there is
nothing yet for it to select *into*, and rather than link to a page that does not
exist, selecting a row does nothing visible until `p6/3` lands.

*Tests*: phase 6 adds no DOM test harness, so the tests sit on the route's
shaping. `test/console-agenda.test.ts` gains the grouping cases: two sessions on
the same local day group under one header even when they straddle UTC midnight;
the day boundary comes from `SETTING_KEYS.timezone`, and a guild with no
timezone seeded fails loudly rather than silently using UTC.

*Review focus*: the page is markup over a JSON response and holds no derivation
of its own — anything computed in the browser is a thing no test can reach. And
the design's one rule that is easy to break by accident: exactly one blurple
element on the screen.

### 3. `p6/3-session-detail` — the session rail · #43

`src/console/session.ts` and the rail the agenda selects into, from
`design/ui_kits/console/DetailRail.jsx` — the design puts session detail in a
300px rail beside the list rather than on a page of its own, and `p6/9-month`
clicks through to the same rail. The roster with `intent` and `attended` side by
side in the `RosterRow` treatment, the thread link from `sessions.thread_id`, the
Discord scheduled-event link built from the guild id in `settings` and
`sessions.discord_event_id`, and the Google sync state read straight off
`calendar_links.synced_at` and `last_error` in the `SyncLog` treatment.
Read-only throughout.

The sync state is what the row says, with the timestamp it says it at. Nothing
here calls Google to find out: the database is the source of truth and the
projector is what writes that row. Projection state is ambient, which is why the
design puts it in the rail rather than behind a button.

The roster shaping — one row per member with intent, attended and no-reply
distinguished — is a function here, not markup, because `p6/5-campaign-page`
forks off this branch to reuse it.

*Tests*: `test/console-session.test.ts` — a session with no `calendar_links` row
reads as "not projected" rather than as an error; `last_error` set with
`synced_at` older than it reads as failing; a roster member with no `attendance`
row appears as no reply, never as out.

*Review focus*: no Discord or Google call on this path at all. The event link is
a URL assembled from ids, never a fetch — and `sessions.discord_event_id` is
losable, because a lapsed event is replaced rather than revived (#36), so a dead
link is expected behaviour and must not be dressed up as a failure. Nothing here
reads the attendance post; the roster comes from D1.

### 4. `p6/4-session-actions` — the three writes · closes #43

The three actions #43 asks for, each behind the confirm shape phase 2's
lifecycle actions already use, each landing a row in `audit_log`, and each
calling the same domain function the bot calls. Opening a targeted poll is #36's
path invoked from a different surface, not a second implementation of it. Lock
closes intent changes for the session. Cancel sets `sessions.state =
'CANCELLED'`, enqueues the projection through `enqueueProjection`, and posts a
notice as a **new** message in the session thread.

No `ics_sequence` here. The column arrives on the other root (`p6/14`), and the
bump lives inside the domain cancel rather than in this handler — which is what
lets this slice be green on its own, and what means the console gets the bump for
free the moment both roots are in `main`. A console handler that incremented a
sequence itself would be the second place that does, which is exactly what
`p6/14` exists to prevent.

*Tests*: `test/console-session.test.ts` gains — cancel writes exactly one audit
row and enqueues one outbox message; opening a poll for a session that already
has one open is refused with the same message the bot gives; a non-organiser gets
403 and no row is written anywhere.

*Review focus*: the invariants, by name. Nothing here edits a posted message —
the cancellation notice is a new post in the thread, and no console action
anywhere may touch `PATCH /channels/:id/messages/:id`. The notice carries no
components, so it mints no `custom_id`; if it ever grows one, it goes through
`src/discord/custom-id.ts`. Every write goes through the bot's domain function; a
second copy of cancel living in `src/console/` is exactly the failure this slice
exists to prevent. And the command surface is still four commands — all three of
these are buttons in the console, which is the whole reason the console has
pages.

### 5. `p6/5-campaign-page` — the campaign, assembled · #44 · forks off `p6/3`

**Forks off `p6/3`**, so it reviews in parallel with `p6/4`. It takes the roster
shaping and the sync chip the session rail introduced rather than cutting a
second set.

`src/console/campaign.ts` and the page, from
`design/ui_kits/console/CampaignPage.jsx`. Phase 2 (#25) already ships the
campaign form and the lifecycle actions; this is the page built around them —
the lifecycle state and its actions in place, cadence stated as anchor plus
interval weeks, quorum, the roster, and the upcoming sessions inside the horizon.

Deliberately not here: the campaign's history (`p6/6`) and its open polls
(`p6/7`). This slice is the campaign's *plan*; what it has already done is a
different query with a different failure mode, and holding both at once is what
pushes this page over the line.

*Tests*: `test/console-campaign.test.ts` — upcoming splits on the `asOf` the
caller passes, not on the clock; a campaign with no materialised sessions says so
in words rather than rendering an empty table; a `CONCLUDED` campaign still
renders, because the page is how an organiser reads what happened to it.

*Review focus*: reuse over re-cut. If the roster block here diverges from the one
in `p6/3`, the shared piece belongs below the fork.

### 6. `p6/6-campaign-history` — the record, and what it implies · #44

The campaign's record: past sessions with `attendance.attended` per person, and
the flake memory from #32 computed over exactly those rows. One PR because the
second is an aggregate of the first — reviewing the streak without the table it
is counted from is reviewing a number nobody can check.

Flake memory is shown as the two numbers it is: attended over on-roster, and the
current said-in-didn't-show streak. It carries the design's own warning that
history starts empty, so it says nothing useful for the first couple of months.
It is information for the organiser and never an automatic consequence — nothing
in phase 6 reads it back.

*Tests*: `test/console-campaign.test.ts` gains — a member who joined last week is
not scored against sessions that ran before `campaign_members.joined_at`; a
session where `attended` is still null counts toward neither side rather than
toward the denominator; a campaign with no history returns zeroes and the page
says so in words; the streak breaks on an attended session and not on a session
the person said out to.

*Review focus*: the denominator. Every flake number is a ratio, and a ratio that
silently counts sessions a person could not have attended is a number that
accuses someone. Read the `joined_at` join before anything else.

### 7. `p6/7-campaign-polls` — open polls and auto-resolve · #44 · forks off `p6/5`

**Forks off `p6/5`**, so it reviews in parallel with `p6/6`. The last two things
#44 asks of the campaign page, split off because they are the phase-4 surface
arriving in the console rather than more of the campaign itself: the open-poll
list — candidate dates, responses so far, the win rule and threshold, each row
linking to the poll post — and the `campaigns.auto_resolve_polls` toggle from
#38, a write through the same domain function and into `audit_log`.

The toggle states its constraint in the copy and not only in the code:
auto-resolve never canonises onto a date the GM has not marked available. A
control labelled "resolve polls automatically" that quietly does something
narrower is a control someone turns on and then blames for the wrong thing.

*Tests*: `test/console-campaign.test.ts` gains — toggling writes exactly one
audit row and touches no open poll; a poll already past its win threshold is
listed as waiting for the organiser when the GM has not marked that date
available.

*Review focus*: this is display plus one boolean. Canonising from the console is
not here and is not in phase 6 at all — Canonise is an organiser-only button on
the poll post, and giving the console a second way to trigger it would put the
same decision behind two different confirmations. The untargeted-poll page itself
(`design/ui_kits/console/PollPage.jsx`) belongs to phase 4; this slice only lists
and links.

### 8. `p6/8-game-day-page` — the day · #44 · forks off `p6/5`

**Forks off `p6/5`** for the page shape, so it reviews in parallel with `p6/6`
and `p6/7`.

`src/console/game-day.ts` and the page: the campaign page's shape applied to a
day — signups with their waitlist positions, the seating state from the #40
lifecycle, capacity from the game for a `single` day, and for a `multi` day the
tables recorded afterwards from `attendance.tables_played` (#39).

The CHECK constraint from `CLAUDE.md` shows through here, and this is the first
screen where a reader can see it: signups hang off the game day, attendance hangs
off the session the day owns, and they are two different lists of people. The
page reads each from its own place and shows both rather than merging them into
one roster that would quietly imply a signup is an intent.

Like the month grid, half of this has no design behind it — `design/readme.md`
closes with multi game-day table recording still open and no UI drawn for it. The
`single` half follows `CampaignPage.jsx`'s roster treatment; the `multi` table
list is built from `DataTable` and existing tokens, no new component and no new
colour, and is the part to expect redrawn.

*Tests*: `test/console-game-day.test.ts` — waitlist order follows
`signups.position` and stays correct after a removal from the middle; a `single`
day shows capacity from the game and a `multi` day shows none; tables played
render only once the day is `PLAYED`.

*Review focus*: nothing on this page may write a signup against a session id —
the constraint would reject it, but the page should not be shaped so that it
could try.

### 9. `p6/9-month` — the month grid · #43 · forks off `p6/1`

**Forks off `p6/1`, not off the agenda page.** It needs the window query and the
route; it needs nothing the agenda page added, so it can be reviewed alongside
it.

A month view asking the same route with `from` and `to` set to the month's
bounds — the reason `p6/1` took a window rather than "upcoming". Seven columns, a
fixed six rows so the grid does not reflow between months, a cell per day
carrying campaign identity swatches and a count, and click-through into the
session rail.

This is the one screen in phase 6 with no design behind it at all:
`design/readme.md` lists the console's month view under "Open questions for the
author" as not drawn. So it is built from tokens and existing primitives only —
the `DayHeader` type treatment, the `--campaign-1..5` identity colours, no new
component and no new colour. If the author draws it later, this PR is what gets
replaced, and it should be small enough that that is cheap.

The rail it clicks into arrives in `p6/3`, which is on the other side of this
fork. Until both are in `main`, a cell is a link with nothing behind it — the
same gap the agenda has for the same review window, and not a reason to serialise
the two.

*Tests*: `test/console-month.test.ts` — the query returns the leading and
trailing days of the adjacent months the grid actually shows, not just the month
proper; a session at 23:30 on the last day of the month lands in that month in
the guild zone; the grid is six rows for a month that would otherwise need five.

*Review focus*: the fork. If this branch imports anything `p6/2` introduced, the
fork is wrong and it should have been stacked instead.

### 10. `p6/10-games-admin` — the games table · #44 · forks off `p6/1`

**Forks off `p6/1`.** It needs the JSON envelope and a nav entry, nothing from
the agenda or the session rail, so it is a third lane that can land early.

The list and edit form over the `games` table from #21 — name, min and max
players, default duration — in the `DataTable` treatment, with a count of the
campaigns pointing at each, so a delete that would orphan a campaign is visible
before it is attempted rather than surfacing as a foreign-key error.

*Tests*: `test/console-games.test.ts` — deleting a game referenced by a running
campaign is refused and says which campaigns hold it; min greater than max is
refused; a non-organiser gets 403; the write lands one `audit_log` row.

*Review focus*: the delete guard is a query, not a catch. Reading the count and
refusing is what lets the page say *which* campaigns; catching the constraint
violation afterwards can only say that one exists.

### 11. `p6/11-settings-admin` — the keys, and only the keys · #44

The second admin page, on top of the first because it reuses its form shell: the
guild and channel ids, the reminder ladder steps from #30, the horizon size the
hourly materialiser reads (#23), and the guild zone. All of these are `settings`
keys that phases 0 through 3 already wrote and already read, so this PR adds
validation and a form — it invents no key and no table. Where a key phases 2 and
3 read is missing a name in `SETTING_KEYS` in `src/db/settings.ts`, this PR gives
it one; a key nothing reads yet is schema ahead of the phase wearing a different
costume, and does not get a field.

The page states what a change costs before it is made: shrinking the horizon does
not delete sessions already materialised, and `discord.guild_id` is rendered
read-only with a sentence saying `scripts/adopt-ids.ts` owns it. Re-pointing the
guild from a web form is not a setting, it is a migration.

*Tests*: `test/console-settings.test.ts` — an unknown setting key is refused
rather than stored; the reminder ladder rejects a non-ascending list of steps; a
timezone that is not an IANA zone `Intl` recognises is refused; a write to the
guild id key is rejected; each accepted write lands one `audit_log` row carrying
the old value and the new one.

*Review focus*: every key writable here is a key something already reads, and the
allow-list is the mechanism — a settings page that writes whatever key it is
handed is a settings page that can seed a key the rest of the Worker will never
look at.

### 12. `p6/12-audit-log` — who changed what · #44 · forks off `p6/1`

**Forks off `p6/1`.** It reads `audit_log` (#21) and the envelope and nothing
else — sitting it on the admin pages would serialise a read-only view behind two
forms it shares no code with.

A newest-first view, filterable by actor and by target. Pagination is keyset on
`(created_at, id)` rather than offset, because an audit log grows at the head and
an offset page re-reads rows it has already shown the moment anyone writes while
you are reading.

It renders in the register `design/readme.md` sets out for the log and for
nothing else: lower case, no full stop, newest first, 24h times, arrows for
transitions — `18:51 alx → campaign age-of-umbra state running → hiatus`. That
register is deliberately unlike every other surface in the console, and this is
the one screen allowed to be curt.

*Tests*: `test/console-audit-log.test.ts` — the keyset cursor neither skips nor
repeats a row when a new entry is written between two page fetches; filtering by
actor returns only that actor's rows; the line renderer is a pure function of a
row, so a transition with a null previous value renders without an arrow rather
than with an empty one.

*Review focus*: read-only, and the gate rather than the queries. The whole view
is organiser-gated, so the thing to check is that the gate is on the route and
not re-decided per row.

### 13. `p6/13-delete-my-data` — the button behind the receipt · closes #44 · forks off `p6/1`

**Forks off `p6/1`.** It needs a page and the session cookie; it needs nothing
from the admin lane or the campaign lane, and it is the one console action that
destroys data, so it gets its own review rather than riding in a settings PR.

The console half of a path that has existed since phase 0: a confirm, then
`deleteUserData` from `src/privacy/delete.ts`, then `describeReceipt`'s text
shown back to the person table by table. No new deletion code and no new table.
If a table is missing from the receipt, the fix belongs in
`src/privacy/delete.ts` in the phase whose PR added it, where every phase that
adds a user-keyed table is supposed to add its own delete and its own count —
phase 6 adds none.

`DELETE /me` in `src/http/app.ts` keeps answering 405 with the sentence pointing
at `/console`; this is the slice that finally makes that sentence true.

*Tests*: `test/privacy.test.ts` gains the route — the action deletes only the
caller's rows and ignores any user id in the body; the receipt counts the
user-keyed tables `src/privacy/delete.ts` knows about; a second click reports
that Orrey held nothing rather than erroring; no session cookie is a 401 and
deletes nothing.

*Review focus*: the deleted id comes from the session cookie and from nowhere
else. An endpoint that accepts an id is an endpoint that erases someone else's
data, which is precisely why phase 0 left `DELETE /me` at 405 instead of
implementing it.

### 14. `p6/14-ics-serialise` — the calendar text · #45 · off `p6/0-base`

**Planned as a second root off `main`, and that was wrong.** Nothing in the ICS
feed reads the *console*, which is what the plan was reasoning about — but `main`
is phase 1, and the feed needs a good deal of what phases 2 to 5 added. Three
things settle it, and each would have been discovered separately and painfully:

- `signups` does not exist on `main`, and `p6/15`'s `all.ics` is "the campaigns
  the holder is on **plus the game days they have signed up for**".
- There is no domain reschedule and no domain cancel on `main` — nothing there
  writes `sessions.state = 'CANCELLED'` at all — so there is nowhere to put the
  `SEQUENCE` increment. The plan foresaw the cancel half of this and said to
  record a divergence rather than write a second increment; the honest fix is
  the root, not the increment.
- `game_days` does not exist either, so `STATUS:CANCELLED` for a called-off day
  has nothing to be derived from.

So the lane roots on `p6/0-base` like everything else in the phase. It still does
not sit on the console lane, which is what the plan was actually protecting: it
forks off the base, beside `p6/1`, and 14 → 15 → 16 remains landable start to
finish without waiting on any console PR.

`src/ics/serialise.ts`: VCALENDAR and VEVENT from the same session-plus-campaign
shape `src/projection/target.ts` already loads. CRLF endings, 75-**octet** line
folding measured in octets rather than characters, `\,` `\;` `\n` escaping, and
`DTSTART;TZID=<zone>` in the guild zone held under `SETTING_KEYS.timezone`, with
the `VTIMEZONE` that defines it. The transitions in that `VTIMEZONE` are
`RDATE`s for the years the feed covers, with offsets read out of
`Intl.DateTimeFormat(zone, { timeZoneName: 'longOffset' })` — not an `RRULE`,
because a feed over a bounded window does not need a rule that extrapolates
forever, and an `RDATE` list is a thing a test can assert exactly.

`UID` is `eventIdFor(session.id)` from `src/google/event-id.ts` with an `@orrey`
suffix, so the ICS event and the Google event carry the same identity and a
support question about one can be answered from the other. Whether a client
merges two subscriptions carrying one UID is the client's business; Orrey does
not rely on it and does not promise it.

A cancelled session is emitted with `STATUS:CANCELLED` rather than dropped:
dropping it leaves the event in every subscriber's calendar forever.

With it, the `SEQUENCE` source: a migration adding `sessions.ics_sequence`
(integer, not null, default 0) and a single increment inside the domain functions
that move or cancel a session — #36's reschedule and whatever phase 4 and 5 left
as the cancel path. The console's cancel (`p6/4`) is a caller of that function
and bumps nothing itself. If it turns out there is no domain cancel to put the
increment in, that is a divergence to record in this file rather than a second
increment to write. Deriving `SEQUENCE` from `updated_at` was the alternative and
is rejected here: RFC 5545 caps it at a signed 32-bit integer and unix seconds
cross that in 2038.

*Tests*: `test/ics-serialise.test.ts` — a folded line never splits a UTF-8
sequence; a comma in a campaign name round-trips through an ICS parser; every
line ends CRLF; `UID` equals `eventIdFor` for the same session id; a session in
July and one in January render with the two different offsets the `VTIMEZONE`
declares; `SEQUENCE` rises when `starts_at` moves and does not when the roster
changes.

*Review focus*: no schema beyond `ics_sequence`, and exactly one place increments
it — grep for it and count. The serialiser takes rows and a zone and touches no
binding, so the route above it can be reviewed for what it selects instead of for
what it prints.

### 15. `p6/15-ics-routes` — two feeds, one token · #45

`src/ics/feed.ts`, and the replacement of the `/ics/:token.ics` 501 stub that has
been sitting in `src/http/app.ts` since phase 0: `GET /ics/:feedToken/all.ics`
and `GET /ics/:feedToken/campaign/:id.ics`.

The token is looked up against `users.feed_token`, unique in `src/db/schema.ts`
since phase 0, and it is the only credential these routes accept. No cookie, no
session gate, no OAuth — a calendar client cannot log in, which is the whole
reason the token exists. An unknown token answers `404` with an empty body; so
does a real token asking for a campaign its holder is not on. The two cases are
indistinguishable on purpose, because a `401` here would confirm which tokens are
real.

`all.ics` is the sessions of the campaigns the holder is on plus the game days
they have signed up for; `campaign/:id.ics` narrows that to one. `Content-Type:
text/calendar; charset=utf-8`, `Cache-Control: private, max-age=900` — `private`
because the token is in the path and a shared cache holding that response is a
shared cache holding the credential.

*Tests*: `test/ics-feed.test.ts` — unknown token and unauthorised campaign
produce byte-identical responses; a holder gets only their own campaigns; a
cancelled session is present with `STATUS:CANCELLED`; the body parses as one
VCALENDAR carrying exactly the expected UIDs.

*Review focus*: these routes are registered **above** the console's session
middleware, not inside it — a cookie must not be required and must not be read.
Nothing on this path writes anything, and nothing on it logs the token.

Verification, written up in the PR body rather than filed as its own issue:
subscribe a real calendar client to a real feed, move a session, and watch Google
take most of a day to show it. That lag is the sentence `p6/16` has to print.

### 16. `p6/16-feeds-console` — the feed URLs and the regenerate · closes #45

The top of the ICS lane, and on it rather than on the console lane: the test
below asserts that a regenerated token stops resolving, and the only thing that
can resolve one is `p6/15`'s lookup. Everything else it needs — the console
shell, the session gate, the form-and-confirm shape — is phase 2's and already in
`main`.

The per-person feeds panel, from the ICS half of
`design/ui_kits/console/PlayersPage.jsx`: `all.ics` and one URL per campaign the
holder is on, built from the request origin, and a regenerate action that mints a
new token and says in plain words that the old URL stops working immediately and
every subscribed client must be re-pointed by hand.

It also carries the sentence #45 asks for, on the panel rather than in a tooltip:
Google refreshes a public ICS feed every eight to twenty-four hours, so a change
made now reaches a subscribed Google Calendar tomorrow. The Orrey calendar is the
timely one; the feeds are for choosing what you see, not for seeing it sooner.

*Tests*: `test/console-feeds.test.ts` — regenerating writes a new token and the
old one stops resolving through `p6/15`'s lookup; a person regenerating changes
nobody else's token; the URLs are assembled from the request origin rather than a
hardcoded host; the audit row records that a token was rotated and never records
what it became.

*Review focus*: the token is a credential. It is never logged, never written into
`audit_log`, and never placed in a URL the console hands to a third party. The
panel is the holder's own — it reads the id off the session cookie, never off the
query string, for the same reason `p6/13` does.

## Landing order

Bottom-first, in four lanes that do not block each other. Nothing in this phase
crosses lanes, so any lane can land first.

The console lane: 1 → 2 → 3, then 4 and 5 in either order, then 6, 7 and 8 in any
order. The month grid, 9, forks off 1 and can land the moment 1 does. The admin
lane: 10 → 11, forked off 1; the audit log, 12, and delete-my-data, 13, each fork
off 1 as well. The ICS lane: 14 → 15 → 16, forked off `p6/0-base` beside 1, landable start to
finish without waiting on any console PR. After each merge, `npm run stack -- restack p6
--apply` and push.

Seven forks and one second root have to be told to the tooling once, or the next
restack flattens them back into the line:

```sh
npm run stack -- base p6/5-campaign-page   p6/3-session-detail
npm run stack -- base p6/7-campaign-polls  p6/5-campaign-page
npm run stack -- base p6/8-game-day-page   p6/5-campaign-page
npm run stack -- base p6/9-month           p6/1-agenda-model
npm run stack -- base p6/10-games-admin    p6/1-agenda-model
npm run stack -- base p6/12-audit-log      p6/1-agenda-model
npm run stack -- base p6/13-delete-my-data p6/1-agenda-model
```

`p6/14-ics-serialise` forks off `p6/0-base`, beside `p6/1` — see the divergence
recorded under slice 14. It is not a second root, and it is not off `main`:

```sh
npm run stack -- base p6/14-ics-serialise p6/0-base
```

Two conflicts to expect, both small and both resolved by keeping every line.
`src/http/app.ts`: `p6/15` replaces the `/ics/:token.ics` 501 stub while the
console PRs register routes a few lines above it. And the console's nav list,
which nearly every page PR appends one entry to.

One thing is out of order by design rather than by dependency. `p6/4`'s console
cancel does not bump `ics_sequence`; the bump lives in the domain cancel and
arrives with `p6/14`. If the console lane lands first, a cancel between the two
merges leaves a sequence unbumped — for a feed nobody can subscribe to yet,
because `p6/15` is what serves one. Nothing to sequence around.

The `Closes` lines sit on 4 (#43), 13 (#44) and 16 (#45). 4 and 16 are the tops
of their lanes and close their issues wherever the order lands. 13 is not: #44 is
spread across the campaign lane and the admin lane, and none of its branches is
above all the others. So 13 is last for #44 by intention, not by graph — land 5
through 8 and 10 through 12 before it. If the order shifts in practice, move the
`Closes` line onto whichever slice actually lands last rather than closing the
issue with work still open.

Phase 6 has **no ops issue**. #20 and #26 set the pattern — something done in the
world and closed with what happened — and none of #43, #44 or #45 carries the
`ops` label or is shaped that way; the whole phase is code. The nearest thing is
subscribing a real calendar client to a real feed and watching Google take most
of a day to notice the first change: that is verification inside `p6/15`, written
up in its PR body, not a separate issue and not a PR of its own.
