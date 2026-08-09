# Gigsy Design System (adopted 2026-08-08)

> Source: claude.ai/design project `4417c96c-1334-4706-9218-e02e48330e06`
> (mirrored in `Gigsy Design System-handoff.zip`). The system was
> reverse-engineered FROM this codebase, so adoption changed no visuals.
>
> Where it lives in this repo:
> - `webapp/src/styles/tokens/*.css` — token files, copied verbatim; imported
>   globally by `webapp/src/styles.css`. Canonical values for color, type,
>   spacing, radius, elevation, motion. `webapp/src/lib/design-tokens.test.ts`
>   pins them against Tailwind's palette so the sources cannot drift.
> - `webapp/src/components/` — the component inventory as typed TSX with a
>   barrel `index.ts` (screens import from the barrel, never internals).
> - `webapp/public/icons/logo.svg` — the app mark (generator output, 512px).
>
> The design project's own readme follows, verbatim.
>
> **Documented extensions since adoption** (the readme below predates them):
> - **A fifth tab, "Reports"** (Phase 7). The readme records four tabs; the
>   stated principle is "text instead of icons in navigation", which a fifth
>   word extends rather than breaks. Five tabs give 75px each at 375px, well
>   over the 44px tap minimum.
> - **`EmptyState` gained a `compact` variant** — the one-line dashed note used
>   inside a populated screen where there is nothing to act on ("Nothing
>   outstanding — every completed job is paid"). It replaces the same recipe
>   that had been inlined in three screens; the full state still always
>   carries a CTA.

---
# Gigsy Design System

## What Gigsy is

Gigsy is a personal tracker for one-off gig work — tasting stands, brand-ambassador shifts,
promo work — across many agencies and clients. It is a lightweight personal CRM plus an
expense ledger, with fast capture by photo or forwarded email. One user, one phone, money
front and centre.

**Product surfaces.** There is exactly one: the **Gigsy webapp** — a React + Vite PWA
(offline-first, installed to the home screen, deployed to Cloudflare Pages). There is no
marketing site, no docs site, no desktop app, and no slide template in the sources. The
Cloudflare Worker backend has no UI.

Core flows: sign in with Google → Dashboard (money at a glance) → Gigs / Clients /
Expenses lists → edit screens → Capture (photo → AI extraction → Draft review → confirm).
A hidden debug console opens on three quick taps of the wordmark.

## Sources

- **Attached codebase:** `gigsy/` (monorepo, mounted read-only via the Import menu).
  - `gigsy/webapp/` — React 18 + Vite + Tailwind PWA. All visual truth lives here.
    - `src/components/ui.ts` — the class recipes this system is built from
    - `src/components/{Header,TabBar,Scaffold,StatusPill,HiddenConsole,LogList}.tsx`
    - `src/screens/*.tsx` — 13 screens
    - `scripts/generate-icons.mjs` — the app mark, as SVG shapes
    - `public/icons/*.png` — the committed PWA icon set
  - `gigsy/docs/superpowers/plans/2026-08-08-phase3-webapp-core.md` §"Design spec" —
    the written visual language (one accent, one radius, one spacing scale).
  - `gigsy/README.md`, `gigsy/gigsy-handoff.md`, `gigsy/docs/plan.md` — product context.
- No Figma file, no decks, no brand guidelines were provided.

## Index

| Path | What |
| --- | --- |
| `styles.css` | Global entry — `@import`s every token file. Consumers link this. |
| `tokens/` | `colors`, `typography`, `spacing`, `radius`, `elevation`, `motion`, `semantic` |
| `components/core/` | Button, Card, Input, Textarea, Select, Field |
| `components/feedback/` | StatusPill, SyncBadge, EmptyState, ListSkeleton |
| `components/navigation/` | AppHeader, TabBar, Fab |
| `components/data/` | Tile, SectionHeading |
| `ui_kits/webapp/` | Click-through recreation of the Gigsy PWA (5 screens) |
| `guidelines/` | Foundation specimen cards (Colors, Type, Spacing, Brand) |
| `assets/` | App mark: `logo.svg`, `icon-512.png`, `icon-192.png`, `apple-touch-icon.png`, `favicon-32.png`, `icon-512-maskable.png` |
| `SKILL.md` | Agent-skill entry point |

### Components

Every component reads its values from the CSS custom properties in `tokens/`; each has a
sibling `.d.ts` (props) and `.prompt.md` (usage).

- **Core** — `Button`, `Card`, `Input`, `Textarea`, `Select`, `Field`
- **Feedback** — `StatusPill`, `SyncBadge`, `EmptyState`, `ListSkeleton`
- **Navigation** — `AppHeader`, `TabBar`, `Fab`
- **Data** — `Tile`, `SectionHeading`

The inventory mirrors the codebase exactly: `ui.ts` (button/input/card recipes),
`Scaffold.tsx` (Field, EmptyState, ListSkeleton, Fab), `StatusPill.tsx`, `Header.tsx`
(+ its inline `SyncBadge`), `TabBar.tsx`, and `Dashboard.tsx`'s `Tile`/section headings.

**Intentional additions:** none. `Textarea` ships inside `Input.jsx` because the codebase
applies the identical `inputCls` shell to both. `SectionHeading` and `Tile` were lifted out
of `Dashboard.tsx`/`GigEdit.tsx` where they exist as local components.

**Deliberately absent:** Tabs, Modal, Toast, Tooltip, Avatar, Accordion, Table, icon
components. Gigsy has none of them — the debug console is a bottom sheet, confirmation
uses `window.confirm`, and there are no toasts or tooltips anywhere.

## Content fundamentals

**Voice: a calm assistant that knows this is your side income.** Plain, specific, never
cute. Copy explains the money consequence, not the feature.

- **Person.** Second person for the user's things ("Your gigs, clients, and expenses"),
  first-person-plural never. The app describes itself in third person: "Gigsy reads it and
  drafts the gig or expense for you to review."
- **Casing.** Sentence case everywhere — headings, buttons, screen titles ("New gig",
  "Add a client", "Sync now"). The **only** uppercase text is the 12px micro-label
  (form labels, section headings): `OFFERED ($)`, `WAITING TO BE PAID`. Status pill text
  stays lowercase always: `lead`, `confirmed`, `completed`, `paid`.
- **Buttons are verb + object**: "Save gig", "Add a gig", "Delete gig", "Capture a gig or
  receipt", "Take or choose a photo". Never "Submit", "OK", "Continue".
- **Empty states name the user's real work**, never generic filler:
  "Capture your first lead — tastings, promo shifts, ambassador work." ·
  "Parking, supplies, mileage — track what gigs really cost." ·
  "Agencies and companies you work gigs for live here."
- **Errors state the fault and the fix, in one sentence, no apology and no exclamation
  marks:** "Save failed — try again." · "Amounts must be greater than zero — leave blank
  when not set." · "Capture needs a connection — the extraction runs server-side." ·
  "The dashboard needs a connection — local data still works from the other tabs."
- **The em dash is the house punctuation mark**, used to attach the consequence to the
  statement. Middle dots (`·`) separate metadata in a row: `Sat, Sep 12, 10:00 AM · Costco 5th`.
- **Progress is a present participle with an ellipsis**: "Saving…", "Syncing…",
  "Connecting…", "Reading the photo…", "Loading…". Always the real `…` character.
- **Reassurance where money or data is at stake**: "Nothing is saved until you confirm."
- **Emoji appear in copy**, sparingly and always leading a label: 📸 ✉️ 📎. Never decorative,
  never more than one per string.
- Absent values are written out: "No client", "No date yet", "None yet.", "Uncategorized",
  "Nothing outstanding — every completed job is paid." Never "—" alone, never "N/A".
- Lowercase technical values stay lowercase (`client`, `worker`, `schema`, `unreachable`).

## Visual foundations

**One accent, one radius, one spacing scale** — stated as the design rule in the phase-3
plan and held to everywhere.

- **Palette.** Light minimalism on slate. App background `slate-50`, surfaces pure white,
  text `slate-900` (strong) / `slate-700` (body) / `slate-500` (muted) / `slate-400` (faint).
  **Accent: emerald-600** (`#059669`) — it means money and work: primary buttons, the FAB,
  the active tab, paid amounts. Status hues are the only other saturated colours:
  slate/sky/amber/emerald. Red exists only for destructive and error text (`red-600`),
  never as a filled button.
- **Type.** System stack only — no webfont, a deliberate PWA start-up decision. Scale is
  10/12/14/16/18/24/30px. 14px semibold is the row title; 12px is metadata; **16px is the
  fixed input size** (smaller makes iOS Safari zoom on focus). 24–30px headline numbers get
  `-0.025em` tracking, bold, and `tabular-nums` so money columns align. 12px uppercase with
  `+0.025em` tracking is the label voice.
- **Spacing.** 4px scale: 2/4/8/12/16/24/32/48. Card padding 16px, list gap 12px, screen
  padding 16px. Every screen is a **512px (`max-w-lg`) centred column** — the phone layout
  simply centres on a desktop, there is no separate desktop design. Safe-area insets are
  padded on the header (top) and the tab bar / FAB (bottom).
- **Backgrounds.** Flat colour only. No photography, no illustration, no pattern, no
  texture, no grain, **no gradients anywhere**. The only imagery in the product is the
  user's own captured receipt/flyer photo, shown as an object-fit preview inside a card.
- **Corner radii.** 12px (`--radius-xl`) on essentially everything: buttons, inputs, cards,
  selects, message banners. 16px for the two "sheet" surfaces (login card, debug console —
  top corners only). Full-round for pills and the FAB. 4px for the tiny console buttons.
- **Cards** = white fill + 1px `slate-200` border + 12px radius + `shadow-sm`. That is the
  whole recipe. Interactive cards raise to `shadow` on hover. No coloured left borders, no
  glow, no double borders. Empty states invert it: transparent-white fill and a **dashed**
  `slate-300` border.
- **Shadows.** Four steps and nothing between them: `shadow-sm` at rest, `shadow` on hover,
  `shadow-lg`/`shadow-xl` for the FAB, `shadow-2xl` for the debug sheet. No inner shadows.
- **Motion.** 150ms is the default, 200ms the ceiling, `cubic-bezier(0.4,0,0.2,1)` the only
  easing. Colour transitions on buttons and tabs, shadow transitions on cards. No bounce, no
  spring, no slide-in, no page transitions. The single keyframe animation in the product is
  the skeleton pulse (2s ease-in-out, opacity 1 → 0.5).
- **Hover** = one step darker (`emerald-600 → emerald-700`, `white → slate-100`,
  `emerald-50 → emerald-100`) plus, on cards and primary buttons, one shadow step up.
  Never opacity, never scale.
- **Press** has no distinct treatment — the platform's own tap highlight is it. There is no
  shrink or depress animation.
- **Focus** is always the same: a 2px `emerald-500` ring via `focus-visible` (inputs also
  turn their border emerald), plus a 2px white offset on filled buttons. Default outlines
  are always removed and replaced, never just removed.
- **Disabled** = 50% opacity and pointer-events off. No greyed-out repaint.
- **Transparency and blur** appear in exactly two places: the sticky header
  (`slate-50` at 90% + `backdrop-blur`) and the fixed tab bar (white at 95% + blur). Nothing
  else is translucent — no glass cards, no scrims, no protection gradients (there is no
  imagery to protect text against).
- **Fixed elements.** Header sticks to the top, tab bar is fixed to the bottom, FAB floats
  above it at `bottom: 80px + safe-area`, debug console is a fixed bottom sheet capped at
  75dvh. Everything else scrolls.
- **Borders** are always 1px and always a slate step: `slate-200` for card hairlines,
  `slate-300` for input borders and dashed empty states. Semantic banners use the 200-step
  of their own hue (`sky-200`, `red-200`, `emerald-200`).

## Iconography

**Gigsy has no icon set.** There is no icon font, no SVG sprite, no Lucide/Heroicons
dependency, and no PNG icons in the UI. This is a real property of the product, not a gap
in the sources — it is worth preserving in anything built with this system.

What stands in for icons:

- **Emoji, inline in labels.** 📸 (photo capture), ✉️ (email-sourced draft), 📎 (payment
  proof attached). Always leading a text label, never alone as an affordance.
- **Unicode text characters** for state: `✓` completed service, `○` open service,
  `↑` in the pending-sync chip (`3↑`), `+` as the FAB glyph and in the "+ Add service" text
  action, `·` as a metadata separator, `…` for in-progress labels.
- **Text instead of icons in navigation.** The bottom tab bar is four words — Home, Gigs,
  Clients, Expenses — with no icons at all. "Sign out" is a text button.
- **Colour carries meaning** where an icon normally would: the status pill's hue is the
  gig's lifecycle state.

**The app mark** (`assets/logo.svg`, `assets/icon-*.png`) is an emerald-600 tile with a
white open ring and bar reading as a "G". It exists only as PWA/favicon artwork — it never
appears inside the UI. It is generated from pure SVG shapes by
`gigsy/webapp/scripts/generate-icons.mjs`; `assets/logo.svg` is that generator's own output
at 512px, and the PNGs are copied from `webapp/public/icons/`.

**The wordmark is plain type**: "Gigsy" set in the system stack, bold, `-0.025em` tracking.
There is no logotype file — do not draw one.

If a build genuinely needs pictographic icons (a chart, a settings screen), that is new
design territory: ask before introducing an icon library, and if one is unavoidable prefer a
1.5px-stroke outline set (Lucide) at 20px in `slate-500`, and flag it as an addition.

## Substitutions & flags

- **Fonts:** none to substitute. Gigsy ships no webfont by design; this system keeps the
  system stack. No Google Fonts fallback is needed or wanted.
- **Icons:** none substituted — see above. Nothing was invented.
- **Logo:** copied from the repo, not redrawn.
- **Dark theme:** `darkMode: "class"` is configured in `tailwind.config.ts` but no dark
  values exist anywhere in the codebase. No dark tokens are defined here.
