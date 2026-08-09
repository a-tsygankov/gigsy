# Design System Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the Gigsy Design System handoff (claude.ai/design project
`4417c96c-1334-4706-9218-e02e48330e06`, mirrored in `Gigsy Design System-handoff.zip`)
as the webapp's styling source of truth. The DS was reverse-engineered *from* this
codebase, so this is a formalization pass, not a redesign: **zero intended visual change**.

**Decisions (pinning the open items):**
- **Tokens are canonical.** `tokens/*.css` are copied **verbatim** into
  `webapp/src/styles/tokens/` and imported globally before Tailwind. Tailwind's default
  palette/scale already equals the token values (the DS lifted them from Tailwind), so
  utility classes keep working unchanged; an **adherence test** asserts the token hexes
  equal `tailwindcss/colors` so the two sources can never drift silently. No
  `var()`-through-Tailwind indirection — it would break the `/90`-style alpha modifiers
  the header/tab-bar scrims use, for no visual gain.
- **Components follow the DS inventory exactly** (core: Button, Card, Input, Textarea,
  Select, Field · data: Tile, SectionHeading · feedback: StatusPill, SyncBadge,
  EmptyState, ListSkeleton · navigation: AppHeader, TabBar, Fab), implemented as typed
  TSX with Tailwind classes (keeping `focus-visible` rings, safe-area padding, testids —
  things the DS's portable inline-style JSX cannot express). Router integration keeps the
  codebase's `to`-prop pattern: `ButtonLink`/`CardLink` share one class recipe with
  `Button`/`Card` (DS rule: "no separate link-button style").
- **One component per file, one barrel** (`src/components/index.ts`) — the DS adherence
  lint's "import from index, not internals" rule. `ui.ts` and `Scaffold.tsx` dissolve
  into the component files; screens import components, never class strings.
- **ui_kits/guidelines/prompt files are reference, not code** — they recreate existing
  screens (verified: no design deltas). Nothing to port from them.
- **Assets:** PWA PNGs already live in `webapp/public/icons/` (the DS copied them from
  there). Only `assets/logo.svg` (the generator's 512px output) is new → copied to
  `webapp/public/icons/logo.svg`.
- **No new dependencies.** Component logic is tested as pure class-builder functions
  under plain vitest; rendering is covered by the existing Playwright suite.
- **E2E is the no-regression gate:** all labels, headings, and `data-testid`s stay
  byte-identical.

**Branch:** dev-9 (stacked on dev-8 / PR #10). No commits without the user's command.

---

### Task 1: Token layer + adherence test

**Files:** `webapp/src/styles/tokens/{colors,typography,spacing,radius,elevation,motion,semantic}.css` (verbatim), `webapp/src/styles.css` (imports), `webapp/tailwind.config.ts` (comment: tokens canonical, test-enforced), `webapp/src/lib/design-tokens.test.ts`

- [ ] RED: test parses tokens/colors.css and compares every step to `tailwindcss/colors`; test asserts semantic.css defines the aliases components consume
- [ ] GREEN: token files in place, imported; tests pass

### Task 2: Component inventory + unit tests

**Files:** `webapp/src/components/{Button,Card,Input,Select,Field,Tile,SectionHeading,StatusPill,SyncBadge,EmptyState,ListSkeleton,Fab,Header,TabBar}.tsx`, `webapp/src/components/index.ts`, `webapp/src/components/classes.test.ts`

- [ ] RED: class-builder tests — button variant×size×block matrix, card interactive lift, input shell, pill status map, tile tones, sync badge states
- [ ] GREEN: components implemented; Scaffold.tsx and ui.ts contents absorbed

### Task 3: Screen refactor sweep

**Files:** all `webapp/src/screens/*.tsx`, `HiddenConsole.tsx`, `AuthGate.tsx` — every raw recipe usage replaced by a component; `ui.ts`/`Scaffold.tsx` deleted

- [ ] No `btnPrimary|btnGhost|btnDanger|inputCls`, no inline card/tile/heading recipes left outside `components/`
- [ ] typecheck + vitest green

### Task 4: Assets, docs, verification

- [ ] `webapp/public/icons/logo.svg` copied from the DS
- [ ] `docs/design-system.md` — the DS readme + project pointer
- [ ] Full sweep: `pnpm typecheck`, `pnpm test`, `pnpm build`, local e2e (wrangler 8787 + vite 5192), browser-pane visual check of Dashboard/Gigs/GigEdit/Login
- [ ] Tree left uncommitted on dev-9 pending user command
