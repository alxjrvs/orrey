# Working in this repo

Read [issue #1](https://github.com/alxjrvs/orrey/issues/1) first. It is the specification,
and the phase epics below it are the ordered work. This file is the short version of the
rules that are easy to violate by accident.

## Invariants

- **Messages are send-only.** Never call the channel message-edit endpoint. The only write
  to an existing message is `UPDATE_MESSAGE` (type 7) as the response to an interaction
  that came *from* that message. The one exception is the cutover strip-components step.
- **Orrey's database is the source of truth.** Discord and Google are projections. Never
  read state back out of a Discord message.
- **Discord is the only identity system.** `identify` scope only; roles come from the bot
  token; never request `guilds`.
- **The command surface is four commands.** Administration belongs in the console. If a new
  command seems necessary, that is a sign the console needs a page.
- **Signups attach to campaigns at formation and to game days — never to an individual
  session.** Enforced by a CHECK constraint.
- **Never write to the user's Social calendar.** Orrey writes only to the Orrey calendar.
- Every component id goes through `src/discord/custom-id.ts`. Unknown ids must degrade to
  the retired-post response, never to "interaction failed".

## Shape

One Worker, three entry points: HTTP (interactions + console + ICS), a queue consumer
(outbound projection), and cron (the clock). Time-based work lives in the D1 `jobs` table,
not in a queue, so it can be inspected and re-run.

Domain tables arrive with the phase that uses them — don't add schema ahead of the phase.
