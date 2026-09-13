# Orrey Design System

Orrey is a scheduling system for **the Orrey of Worlds**, a TTRPG Discord: four campaigns,
a rotating cast, and the one-off game days in between. It replaces hand-managing all of it.

Orrey's own database is the source of truth. **Discord and Google Calendar are displays.**
Discord is also the only login. It runs as one Cloudflare Worker — TypeScript, Hono, D1,
Drizzle — with three entry points: HTTP (interactions, console, ICS), a queue consumer for
outbound projection, and cron for the clock.

The product's central question is **"does it run"** — quorum, not just a date on a calendar.
When the answer is no, the response is a date poll, not a cancellation. Everything in this
design system is downstream of that sentence.

## Sources

| Source | What it gave |
|---|---|
| `https://github.com/alxjrvs/orrey` (branch `main`) | The specification. The build plan rev 5 (then `docs/build-plan.md`, now issue #1), `README.md`, `CLAUDE.md`, `src/db/schema.ts`, `src/discord/commands.ts` |
| `https://claude.ai/code/artifact/fa328d17-dff9-4ce9-84a3-4860b9270733` | The live build-plan document (same content, now issue #1). Not readable without the author's account |
| Hermuz (archived, read-only) | The predecessor: ~14,500 lines of TypeScript, last commit 2026-08-20. Read as a specification, never ported. Not accessible from here |

**There was no visual source.** The repo is at phase 0 and ships exactly one page —
`public/index.html`, a holding page in system sans. There is no Figma file, no logo, no
existing console. Everything visual in this system was designed from the written
specification and the brief "functional, avoid AI design tells", then chosen by the author
from three candidate directions (see `directions/`).

## Surfaces

- **Discord** — where the product lives until phase 2, and where nearly every answer arrives
  from afterwards. Buttons on posts; four ephemeral commands; send-only messages.
- **The console** — form-shaped administration a slash command models badly: campaigns,
  cadence, rosters, date polls. Holding administration here is what keeps the command list
  at four.
- **Google Calendar** — a projection Orrey writes to and reconciles. Never a source.

---

## Content fundamentals

The repo's own prose is the voice, and it is unusually consistent. Copy anywhere in Orrey
should read as though it came out of `CLAUDE.md`.

**Declarative, present tense, no hedging.** The product states what is true and what it
does. "Orrey never edits a post it has already sent." "Messages are send-only." "The
database is the source of truth." Not "Orrey will try to…", not "we recommend…".

**Second person for the player, third person for the system.** A player reads "you are on
the roster for three things". The system is named: "Orrey does not know what to do with
that", never "I". The organiser is "the organiser" or "the GM", not "the admin".

**Sentence case everywhere. Uppercase is a typographic choice, not a copy choice.** Write
`Suggest another day`, `Take a seat`, `Nudge 1`; the mono label style uppercases them at
render. Never write copy in caps.

**Buttons are imperatives with an object.** "Take a seat", "Suggest another day",
"Canonise", "Post next session". Not "Submit", "OK", "Continue".

**Costs are stated, not hidden.** The plan's habit of naming what a decision costs carries
into the UI: "Posts are snapshots and go stale." "Short of quorum. The answer to that is a
date poll, not a cancellation." "History starts empty, so flake memory says nothing for a
couple of months." Never apologise, never over-explain.

**The log speaks as a machine.** Lower case, no full stop, newest first, 24h times, arrows
for transitions: `18:51 priya → in via button`, `50007 dm blocked, fell back to channel
mention`. This is the one register where the product is terse to the point of curt, and it
is deliberately different from every other surface.

**Domain words are fixed. Use these and no synonyms.**

| Use | Never |
|---|---|
| campaign, session, game day, one-off | event (except a Discord/Google *scheduled event*), meetup |
| in / out / maybe / no reply | yes / no / RSVP / attending |
| quorum, jeopardy | minimum, at risk, in danger |
| date poll, candidate date, canonise | availability survey, vote, finalise |
| roster, seat, waitlist | party, slot, queue |
| forming / running / hiatus / concluded | active / inactive / archived |
| as of 19:02 | last updated, live |
| projection, display | sync, mirror |

**Numbers are always mono and always exact.** "4 / 6", "needs 3", "11 of 12 seats". Never
"a few", never "most of the group".

**No emoji.** Not in the console, not in bot posts, not in commit-adjacent copy. The build
plan contains none; neither should the product. Discord's own UI supplies the only glyphs
in the system (#, 🔊 in the channel list) and those belong to Discord, not to Orrey.

**No exclamation marks, no encouragement, no personality voice.** Orrey is a clock. It does
not congratulate you for showing up.

---

## Visual foundations

### The shape of it

Dense, square, hairline-ruled, and set on Discord's own greys. The console is closer to a flight-plan readout
than to a consumer scheduling app, because the person using it is reconciling four
campaigns and seventeen people, not browsing.

### Colour

Discord-weight greys — lighter and warmer than a true near-black — with exactly **one**
accent: blurple `#5865f2`. The page is `#313338` and the chrome sits *darker* at `#2b2d31`,
the same inversion Discord uses, so the console feels continuous with the surface players
already live in. The accent marks the primary action and the current selection and nothing
else — if a screen has two blurple things, one of them is wrong. Semantic hues are
Discord's: green `#23a559` in, amber `#f0b232` maybe or jeopardy, red `#f23f43` out or
cancelled. There is no second brand colour and no gradient anywhere. Campaign identity colours (`--campaign-1..5`) are assigned per
campaign and are never reused as UI colour.

Dark is the only mode. There is no light theme, and the design does not pretend one is
coming.

### Type

**Space Grotesk** for interface, **JetBrains Mono** for everything the machine knows: dates,
counts, ids, log lines, and all small caps labels. The split is strict — if a string is a
number, an identifier, or a timestamp, it is mono. Body is **13px**, not 16: the console
runs small on purpose. Display tops out at 26px; there are no hero headings because there
is no marketing surface.

Small mono labels are tracked wide (0.16em) and uppercased in CSS. The wordmark is the same
treatment at 0.14em.

### Backgrounds

Flat. No images, no illustration, no texture, no gradient, no noise. Depth comes from five
steps of slate and two weights of hairline, nothing else. There is no photography anywhere
in the product — avatars are square initials in mono.

### Borders, cards, shadows

Cards as such do not exist. A `Panel` is a 1px `--line-structural` border around content
with a mono caps header; square, unshadowed, never nested. Rows in a list are separated by
the lighter `--line-hair`. **There are no drop shadows in the console at all.** The only
shadow tokens are for genuine overlays (`--shadow-overlay`) and Discord's own chrome.

### Corner radii

Zero, with three exceptions: status **pills** are fully round (`99px`), Discord **avatars**
are circles, and Discord **embeds** use Discord's own 8px. Everything else — buttons,
inputs, panels, avatars in Orrey's own chrome, the quorum meter's squares — is square.

### Selection, hover, press, focus

- **Hover**: background lifts one slate step to `--surface-raised`. 90ms. Nothing moves, nothing scales.
- **Selection**: `inset 2px 0 0` accent bar on the left edge, plus the raised background. Never a glow, never a border colour change.
- **Attention**: the same inset bar in amber, background unchanged.
- **Press**: the accent darkens to `--signal-600`. No shrink, no translate.
- **Focus**: 1px signal outline, 1px offset. Visible, never removed.
- **Disabled**: opacity 0.4, cursor `not-allowed`. No greyed-out recolouring.

### Motion

90–220ms, one easing curve (`cubic-bezier(.2,0,.2,1)`), and only ever to confirm a state
change: a hover colour, a rail swapping content, a quorum meter filling. **No entrance
animations, no page transitions, no spinners on list loads, no bouncing, no springs, no
parallax.** A list that is loading shows nothing rather than a skeleton.

### Transparency and blur

None. No frosted panels, no scrims except the one behind a true modal
(`--scrim`, flat `rgba(7,9,11,.72)`), no `backdrop-filter` anywhere. Text is never set on a
translucent surface, so there are no protection gradients — the system has no imagery to
protect text from.

### Layout

Fixed chrome, scrolling middle. Top bar 44px, left rail 210px, detail rail 300px, status
bar 26px, page gutter 18px. Rows come in three densities: 34px dense, 44px default, 58px
agenda. Spacing is on a 2px base and most real gaps land between 6 and 14px.

### The quorum meter

The one piece of information design the product is built around. One square per roster seat,
filled in fixed order — in, maybe, out, then silent. Silent is an outline, because **no
reply is not a no**. Below quorum, the trailing count turns amber and appends "needs N"; it
never says "cancelled".

---

## Iconography

**Orrey has no icon set, and this system does not add one.** The repo contains no icons, no
sprite, no icon font, and no SVG assets of any kind. Rather than import Lucide or Heroicons
and pretend it was a brand decision, the system does the icon's job with shape and type:

- **State** is a filled square (5–14px) in a semantic colour — the sync dot, the campaign
  swatch, a quorum pip, the attended mark.
- **Identity** is initials in mono inside a square — there are no avatars, photos or
  illustrations anywhere.
- **Structure** is a hairline. Dividers, gutters and the inset selection bar carry the
  hierarchy an icon would otherwise carry.
- **Direction** is a CSS triangle: the select caret, drawn with borders, is the only
  arrow-shaped thing in the system.
- **Actions are words.** Buttons are labelled, never glyph-only. "Nudge 1", not a bell.

Two glyph sets appear and neither is Orrey's: the **#** and **🔊** in the Discord channel
list, and Discord's own button chrome. Both belong to Discord and appear only inside
`ui_kits/discord`. **Emoji are not used by Orrey anywhere.**

If a future surface genuinely needs icons, add them as a documented decision — do not let
one leak in through a component.

## Logo

**There is no logo.** No mark exists in the repo or anywhere the author provided. The brand
is the name, set in type: `Wordmark` renders "ORREY·OF WORLDS" in Space Grotesk 700,
uppercase, tracked 0.14em, with the interpunct in blurple. The Discord bot avatar is
"OR" in the same face. Nothing here was drawn or reconstructed. If a mark is commissioned,
it replaces `Wordmark` and `assets/` gains its first file.

## Type substitution

Space Grotesk and JetBrains Mono were **chosen**, not inherited — no typeface was specified
anywhere in the sources. Both are loaded from Google Fonts in `tokens/fonts.css` rather than
self-hosted, so no binaries ship with this system. `--font-discord` is a fallback stack only: Discord's real UI face is `gg sans`, which is
proprietary and not redistributable, so Discord mockups approximate rather than match it.

---

## Index

```
styles.css              Entry point. @import list only — link this one file
tokens/
  fonts.css             Google Fonts import; the two families
  colors.css            Slate, signal, semantic, campaign identity, Discord palette
  typography.css        Families, sizes, tracking, composed --type-* roles
  spacing.css           2px scale, fixed chrome dimensions, row rhythm
  borders.css           Radii, border presets, selection markers, the two shadows
  motion.css            Durations and the one easing curve
  base.css              Element resets, link colours, focus ring, scrollbars
guidelines/             18 foundation specimen cards (Colors, Type, Spacing, Brand)
components/
  core/                 Button, Pill, Tag, Panel, Field + Input, Select, Checkbox
  nav/                  TopBar + Wordmark, SyncChip, Sidebar + SidebarSection + NavItem,
                        SegmentedFilter, StatusBar + StatusItem
  data/                 DataTable + Cell, DayHeader, QuorumMeter, SessionRow,
                        RosterRow + Avatar, SyncLog
  discord/              DiscordMessage, DiscordEmbed, DiscordButtonRow, DiscordSelect,
                        EphemeralNote
ui_kits/
  console/              The phase-2 console: agenda (two variants), campaign, date poll, players
  discord/              Bot posts: attendance, signup, poll, jeopardy notice, /upcoming, retired
  entry/                Discord sign-in, first-run id adoption, the Orrey calendar
directions/             The three candidate directions; B (Console) was chosen
github.md               Repo association and sync record
SKILL.md                Agent Skills front matter for use outside this project
```

Every component directory carries `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md` and one
`@dsCard`-tagged HTML card.

## Intentional additions

The sources define no component library, so the inventory above was derived from the
specification's surfaces rather than copied from an existing one. Two entries deserve a
note:

- **`QuorumMeter`** — not named in the plan, but the plan's central question is "does it
  run". The product needs one consistent way to show it.
- **`Wordmark`** — stands in for the absent logo so no screen has to invent one.

The Discord components mirror real platform constraints (five buttons per row, the
multi-select a ten-date poll requires, the ephemeral footer) rather than inventing UI.

## Open questions for the author

1. Is there a logo, or should the wordmark stand? If a mark exists, it changes the top bar, the Discord avatar and the thumbnail.
2. Space Grotesk and JetBrains Mono are a pick, not a mandate. Worth a second look before the console is built.
3. The console's month view and campaign-page session log (phase 6/7) are not designed here — say the word.
4. Multi game-day table recording is still open in the plan; no UI was drawn for it.
