# UI kit — entry points

Three surfaces that sit either side of the console.

| Screen | What it is |
|---|---|
| `Login` | Discord OAuth. `identify` scope alone; `guilds` is never requested. Privacy and delete-my-data links are required by Discord's terms and are present from phase 0 |
| `FirstRun` | The cutover in console form: adopt the guild, role, channel and scheduled-event ids from Hermuz, then enter four campaigns by hand. **No data is imported** |
| `CalendarView` | The Orrey calendar — a projection, not a source. Deterministic base32hex event ids, a content fingerprint to stop the return path echoing, and per-campaign ICS feeds |

Built from the specification (issue #1) and `src/http/app.ts`. The week grid is Orrey's
own rendering of its calendar, not a recreation of Google Calendar's interface.
