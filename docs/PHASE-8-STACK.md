# Phase 8 — The veto default, as a stack

[#173](https://github.com/alxjrvs/orrey/issues/173) is the epic. It replaces the
question phase 3 asks — *how many said yes* — with the one the games actually run
on: *does anybody object*.

The rule, in one sentence: **once a campaign has a roster, attendance is unanimous
and silence is in; before it has one, a quorum is the only thing a count can mean.**

Nothing here adds a column. `campaigns.quorum` is the opt-out — setting it is how an
organiser says "no, count them", which is what that column has always meant — and
which rule applies is derived from the campaign's state and its roster. A derived
rule cannot fall out of step with the data it is derived from, and a migration that
rebuilds `campaigns` would cascade-delete every session (docs/GOTCHAS.md), so this
phase has no migration at all.

## The slices

| Branch | What lands | Issue |
| --- | --- | --- |
| `p8/1-veto-rule` | The rule, derived and answered in one place. `AttendanceRow` learns who is on the roster; `quorumOf` answers under whichever rule applies; the console reads roster members rather than a count so it renders from the same rows the post does. | #173 |
| `p8/2-veto-jeopardy` | The clock's half. A day out, the check asks for objections rather than a tally, and the notice names who cannot make it. | #173 |
| `p8/3-veto-reschedule` | The click's half, and the answer to a veto: the session is marked, a `session.reschedule` job is armed, and the drain opens a date poll on the days around the one that fell through — under a whole-roster win rule. | #173 |
| `p8/4-veto-register` | The register. Under a rule that says silence is in, assuming everybody who said nothing was absent is a register that is wrong about every session. | #173 |
| `p8/5-veto-surfaces` | What the surfaces say: the console's quorum field as the opt-out it now is, the agenda and session detail, the reminder ladder's nudge, and the rule named in CLAUDE.md. | #173 |

`p8/1` is the only slice that changes a shared type, which is why it is the bottom
one and why every slice above it is additive.

## Why the veto is not a cancellation

Because [#1](https://github.com/alxjrvs/orrey/issues/1) is right: *when the answer is
no, the response is a date poll.* A veto does not call an evening off — it says the
evening as scheduled will not work, which is a question about dates and not a
decision about the session. So `p8/3` opens a poll and `CANCELLED` stays reachable
only through `cancelSession`, which is somebody clicking it.

The one place the veto rule makes a count worth having again is that poll, in its
strictest form: the date that wins is one **everybody assigned to be there** can
make. `quorum_of_roster` at a threshold of 1.0 already computes exactly that, so the
win rule needed nothing new either.

## What no slice does

- **Un-veto.** Withdrawing an `out` after the poll has gone up does not take the poll
  back down. The evening is already being discussed, and retracting the question is
  the organiser's call — like every other reversal in this repo.
- **Confirm.** Under the veto rule there is no threshold to cross, so nothing writes
  `CONFIRMED`: a session with a roster and no objection is on from the moment it is
  made, and posting "It's on" about it would be announcing what the post has said all
  along. The rule moves a session one way only.
