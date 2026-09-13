repo: alxjrvs/orrey
branch: main
path: (whole repo)

## Last sync
date: 2026-09-13T02:38:00Z
commit: (unknown — tree hash 1cb85c1dc9c3; no commit sha resolved)

### Updated in this project
- Read the full build plan (`docs/build-plan.md`), README and CLAUDE.md as the specification behind this design system.
- Confirmed the repo is at phase 0: the only shipped UI is `public/index.html`, a holding page.
- Lifted the product's vocabulary, command surface and voice directly from the repo prose.

## Screen map
| Screen | Built from |
|---|---|
| ui_kits/console/* | docs/build-plan.md (console section, domain model), src/db/schema.ts, README.md |
| ui_kits/discord/* | docs/build-plan.md (Discord surface), src/discord/commands.ts, src/discord/interactions.ts |
| ui_kits/entry/* | docs/build-plan.md (Discord identity, Google Calendar), src/http/app.ts, public/index.html |

Note: the repo contains **no console UI**. Everything in `ui_kits/` is a new design drawn
to the written specification, not a recreation of existing screens.
