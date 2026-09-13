# UI kit — Orrey in Discord

Where the product actually lives until phase 2, and where nearly every answer arrives from
after that. Buttons sit on the thing they concern.

Built from the specification (issue #1 — Discord surface), `src/discord/commands.ts` and
`src/discord/interactions.ts`. Discord's own palette is used throughout — the
`--discord-*` tokens — because these are mockups of posts inside Discord, not Orrey screens.

## Posts

| Component | Post |
|---|---|
| `AttendancePost` | In / Out / Maybe / Note, plus Suggest another day and Refresh. Clicking rewrites this message as the interaction's own response — the only edit Orrey ever performs |
| `SignupPost` | Take a seat / Waitlist / Out. Full table, waitlist promotes automatically |
| `PollPost` | Ten dates need a multi-select, because a button row holds five. Canonise is organiser-only |
| `JeopardyNotice` | A **new** post, not an edit — the design cost of send-only, paid deliberately |
| `UpcomingReply` | `/upcoming`, ephemeral. Replaces the idea of a pinned board |
| `RetiredPost` | An unknown `custom_id` degrades to this, never to "interaction failed" |

## Rules this kit encodes

- **Every post with a tally carries an as-of line and a Refresh button.** Posts are
  snapshots; the as-of line is what keeps them honest.
- Anything that changes from outside — a session moved, jeopardy at T-24h, a waitlist
  promotion — **posts a new notice**.
- All four commands answer ephemerally, wrapped in `EphemeralNote`.
- Five buttons per row, hard limit.
