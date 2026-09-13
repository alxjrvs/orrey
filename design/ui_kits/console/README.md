# UI kit — the Orrey console

The web surface. Discord is where players answer; the console is where the organiser does
form-shaped work a slash command models badly. Keeping administration here is what holds
the Discord command list to four.

**This is a new design, not a recreation.** `alxjrvs/orrey` is at phase 0 and ships only a
holding page (`public/index.html`); the console lands in phase 2. Every screen here is
drawn to the specification (issue #1) and the domain model in `src/db/schema.ts`.

## Screens

| File | Screen |
|---|---|
| `App.jsx` | Chrome: top bar, sidebar, status bar, view switching |
| `Agenda.jsx` | Two separate views off one component — **What I'm scheduling** (the work) and **What's confirmed** (the record). Day-grouped, with a By day / Flat toggle |
| `DetailRail.jsx` | Selected session: quorum, roster, actions, sync log |
| `CampaignPage.jsx` | Cadence (anchor + interval), quorum, roster, session horizon |
| `PollPage.jsx` | Date poll with no target — candidate dates, win rule, canonise |
| `PlayersPage.jsx` | Known players, DM state, flake memory, ICS feed tokens |
| `data.js` | All fixture data on `window.ORREY` |

## Things the design is asserting

- Scheduling and confirmation are **different concerns, so they are different views**, not
  two halves of one list. The first is a worklist and carries the only primary action; the
  second is a record and carries none.
- The agenda answers **"does it run"** before it answers "when is it".
- A session short of quorum is amber, never red, and the action offered is *Reschedule* —
  the product's answer to a short session is a date poll, not a cancellation.
- The sync log sits in the rail, not a modal. Projection state is ambient.
- Nothing in the console ever edits a Discord post. *Repost* sends a new one.
