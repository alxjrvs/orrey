---
name: stack
description: Cut a phase as a stack of small reviewed PRs — how to slice the issues, the branch and base convention, the review gate every PR passes before it lands, and how to restack the rest once the bottom one merges. Use when starting a phase (phase 1 is planned in docs/PHASE-1-STACK.md, issues #16–#20), when adding a PR to a live stack, or when a stacked PR's base has just merged.
---

# Stacked, reviewed PRs

Phase 0 was cut as a train of small PRs off `main`, one at a time (#50–#59). That
works while each piece is independent. Phase 1 is not: the schema is under the
projector, the projector is under both surfaces. Waiting for review between them
means the phase advances one review round-trip at a time.

So: cut the whole slice as a **stack** — each PR based on the one before it,
every one open and reviewable now, landing bottom-first.

## The convention

- **Branch** `p<phase>/<n>-<slug>` — `p1/3-outbox`. The ordinal is what makes the
  chain machine-readable; `scripts/stack.ts` sorts on it. Leave gaps (10, 20, 30)
  only if you expect to insert; renumbering is a rename, not a rebase.
- **Base** is the previous branch in the stack. The bottom PR's base is `main`.
  Set it when you open the PR — a stacked PR opened against `main` shows the
  whole stack as its diff and cannot be reviewed.
- **One PR is one reviewable idea**, not one issue. An issue becomes two or three
  PRs whenever its checkboxes split cleanly (see #18 in the phase-1 plan). A PR
  never spans two issues — a reviewer should never have to hold two goals.
- **Under ~400 changed lines**, tests included. Over that, it is two PRs.
- **Every PR is green on its own**: `npm run typecheck && npm test` pass at that
  commit, with the tests for that slice in that PR. A PR that only goes green
  once the one above it lands is mis-sliced.
- **Draft until CI is green**, then mark ready. Title in the repo's voice: a
  sentence about what changed, not a ticket number — "One cron trigger, four
  schedules derived from the clock". Body: what, why, what is deliberately *not*
  here, and `Part of #<issue>` (only the last PR of an issue says `Closes #`).
- **First line of the body names the base**: `Stacked on #<pr>` — GitHub does not
  say it loudly enough.

## Cutting the stack

1. Read the phase epic and its issues. Write the plan down first — for phase 1 it
   is already written: `docs/PHASE-1-STACK.md`. If reality diverges, edit that
   file in the PR that diverged.
2. `git checkout -b p1/1-… main`, build the slice, commit, push, open the PR as a
   draft against `main`.
3. `git checkout -b p1/2-… p1/1-…` — do not go back to `main` — build, push, open
   against `p1/1-…`. Repeat.
4. Anything that depends only on a lower branch may **fork** rather than extend:
   the Google projection hangs off the outbox PR, not off the attendance chain.
   Same numbering, base set to the branch it forked from. `stack.ts` assumes one
   line, so restack a fork by hand (`git rebase --onto <its base> …`).

## The review gate

No PR lands, bottom or not, until all four hold:

- `npm run typecheck` and `npm test` locally, and `quality-checks` green on the PR.
- **`/code-review`** run on the branch, and its findings either fixed or answered
  in a reply. Red findings are never optional.
- **The invariants in CLAUDE.md**, checked against this diff by name — not "looks
  fine". The ones phase 1 can actually break:
  - no `PATCH /channels/:id/messages/:id`; the only rewrite is `UPDATE_MESSAGE`
    (type 7) answering a click from that message
  - nothing reads state back out of a Discord message
  - every `custom_id` minted and parsed via `src/discord/custom-id.ts`; an
    unknown id degrades to the retired-post response
  - no schema beyond what this phase reads
  - writes go to the Orrey calendar only
  - the command surface is still four commands
- **A human read it.** Bot review is a floor, not the gate.

## Landing, then restacking

Merge **only the bottom PR**, squash, delete its branch. GitHub retargets the
child PR onto `main` automatically. Then:

```sh
git fetch origin && git checkout main && git pull
npm run stack -- status p1                  # what moved
npm run stack -- restack p1 --apply         # replay the rest onto the new main
npm run stack -- push p1 --apply            # --force-with-lease
git branch -D p1/1-…                        # squashed: it rebases to 0 commits
```

Then re-read the child PR's diff on GitHub. A squash merge plus a restack can
leave a change silently duplicated or dropped; the diff is the only thing that
proves it did not.

Three rules about rewriting history here:

- Restack **only your own stack branches**. Never rebase a branch someone else
  has checked out, and never rebase to "tidy" a PR mid-review — the reviewer
  loses their place. Push new commits instead; the squash cleans up at the end.
- A restack that hits a conflict stops on that branch and leaves the ones above
  it untouched. Resolve, `git rebase --continue`, re-run restack.
- If the bottom PR sits in review for days and the stack above it is done, do not
  merge upward to unblock yourself. Either the review matters or the slice was
  wrong.

## Mechanics

`scripts/stack.ts`, via `npm run stack --`:

```sh
npm run stack -- status p1 --prs      # chain order, drift, remote state, PR state (needs gh)
npm run stack -- restack p1           # print the rebase plan
npm run stack -- restack p1 --apply   # run it, in order, returning you to the branch you were on
npm run stack -- push p1 --apply      # force-with-lease the whole stack
```

`status` says `NEEDS RESTACK` when a branch no longer sits on its parent's head —
which is what a merged bottom, or any push to `main`, causes.

## What does not become a PR

Ops issues — the phase-1 gate #20, the id capture in #26 — are done in the world,
not in the repo, and are closed with what happened. The stack ends at the last
code PR.
