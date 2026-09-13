# Phase 1 as a stack

The plan for cutting [#3](https://github.com/alxjrvs/orrey/issues/3) — issues
#16–#20 — as eight stacked PRs. The workflow these follow is
`.claude/skills/stack/SKILL.md`; this file is only the slicing, and it is a
plan, not a contract: when a slice turns out wrong, change it here in the PR
that diverged.

Phase 1 does not stack as one line. The schema is under everything, the outbox
spine is under both projections, and the two projections are independent of each
other — so `p1/8-gcal` **forks** off `p1/3-outbox` rather than sitting on top of
the attendance PRs. It can be reviewed and landed while they are still in review.

```
main
 └── p1/1-schema (#16)
      └── p1/2-seed (#16)
           └── p1/3-outbox (#17)
                ├── p1/4-discord-event (#17)
                │    └── p1/5-attendance-render (#18)
                │         └── p1/6-attendance-buttons (#18)
                │              └── p1/7-attendance-note (#18)
                └── p1/8-gcal (#19)
```

## The slices

### 1. `p1/1-schema` — the four tables · #16

`src/db/schema.ts` plus the generated migration: `campaigns` (only the columns
phase 1 reads — id, name, kind, channel/role/colour, location_type, state),
`sessions` (explicit `kind` from day one, `campaign_id`, number, starts_at /
ends_at, location, state, discord_event_id, discord_message_id, thread_id),
`attendance` (intent, attended, attended_source, note), `calendar_links`
(gcal_event_id, fingerprint, synced_at, last_error).

*Tests*: migrations apply in the workerd pool; the `sessions.kind` CHECK rejects
a row with neither parent; `calendar_links.gcal_event_id` is unique.

*Review focus*: no column phase 1 does not read. Cadence, quorum and the
game-day foreign key belong to later phases — the CHECK that pairs `kind` with a
parent arrives with game days, but `kind` itself is here.

### 2. `p1/2-seed` — the one hardcoded campaign · closes #16

`scripts/seed-session.ts`: insert the Age of Umbra campaign pointed at its real
role and channel ids (from `ops/adopted-ids.json`, per the cutover skill) and one
session, local or `--remote`. No Worker code.

*Review focus*: ids come from the file, never from literals in the repo; running
it twice does not make a second campaign.

### 3. `p1/3-outbox` — the projection spine · #17

The part both projections share, and the reason this is one PR and not two: the
producer (`enqueueProjection(sessionId)`, called wherever a session is created or
changed), the content fingerprint, and the real body of `handleQueueBatch` —
load the session, dispatch on `kind`, compare the stored fingerprint, record
`last_error`, retry, and let the DLQ take what keeps failing. Neither projection
writes anything outward yet.

*Tests*: redelivering the same message twice does one unit of work; a message for
a deleted session acks rather than poisons; a thrown projector records the error
and retries.

*Review focus*: the fingerprint covers exactly the fields the remote object shows.

### 4. `p1/4-discord-event` — the scheduled event · closes #17

Build the event from session + campaign (`EXTERNAL` vs `VOICE` from
`location_type`), create when there is no `discord_event_id` and modify when
there is, store id and fingerprint. Every REST call through `GuildGovernor`.

*Review focus*: no call to Discord outside the governor; a matching fingerprint
skips the write entirely; the id is treated as losable — a lapsed event will need
a new one in phase 4, so nothing may assume it is stable.

### 5. `p1/5-attendance-render` — the post · #18

Rendering, separated from clicking so the two review as one idea each: rows from
D1 → a message payload with who's in / out / maybe, the as-of line, and the five
buttons (In / Out / Maybe / Note / Refresh), every `custom_id` minted through
`src/discord/custom-id.ts`. Posting it to the campaign channel records
`discord_message_id` and then forgets it — this surface is never reconciled.

*Tests*: the renderer is a pure function of rows (no clock, no fetch — pass the
as-of time in); ids round-trip through `decodeCustomId`.

*Review focus*: send-only. Nothing here may edit a message; nothing may read one.

### 6. `p1/6-attendance-buttons` — the click · #18

`COMPONENT` handling: decode the id, take the per-session `SessionLock`, upsert
the clicker into `users`, write `attendance.intent`, re-render from D1, answer
with `UPDATE_MESSAGE` (type 7).

*Tests*: two clicks landing together produce one correct tally (the lock); an
unknown id answers the retired-post response; the handler reads D1 only — the
interaction's own message body is never parsed.

*Review focus*: type 7 answering the click's own message, and nothing else that
touches a posted message.

### 7. `p1/7-attendance-note` — modal and refresh · closes #18

`Note` opens a modal, `MODAL_SUBMIT` stores the free text against the attendance
row and re-renders; `Refresh` re-renders with a fresh as-of line — the sanctioned
cure for a stale snapshot.

*Review focus*: the modal's `custom_id` carries the session through the round
trip and is minted the same way; note text is stored and rendered as text, never
as markup that could impersonate the bot's own lines.

### 8. `p1/8-gcal` — the Google event · closes #19 · forks off #3

Service-account JWT → access token cached for its lifetime; deterministic
base32hex id (`src/google/event-id.ts`, proved in phase 0); `insert`, and on
`409` `update`; fingerprint skip; `synced_at` / `last_error` on
`calendar_links`.

*Review focus*: **the Orrey calendar id only** — no code path can name the user's
Social calendar. Redelivery lands on the same event id.

## Landing order

Bottom-first: 1 → 2 → 3, then 4 and 8 in either order, then 5 → 6 → 7. After each
merge, `npm run stack -- restack p1 --apply` and push; `p1/8-gcal` forked, so
restack it by hand against its own base.

The phase gate, #20, is not a PR: run a real Age of Umbra session on it once the
stack is in `main`, and close #20 with what happened on the day.
