# Phase 11: Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One screen that owns the knobs currently scattered across the app,
hardcoded, or hidden. Requested 2026-08-10; the list below starts from the
user's and adds what the codebase shows is missing.

## Requested

| Setting | Today | Notes |
| --- | --- | --- |
| Optional `Gigsy: ` prefix on event titles | hardcoded `client — location` | Makes Gigsy events scannable among personal ones. Off by default — it costs title width on a phone. |
| Sync to a **dedicated Gigsy calendar** | everything goes to `primary` | The user asked "general or a new one for Gigsy?" — this makes it a choice. Needs the `calendar` scope (creating a calendar) on top of `calendar.events`, so it re-prompts for consent. |
| See the forwarding email address | exists in code, never surfaced | `u-<userId>@<domain>`. Show it **only** once a domain is configured; otherwise say plainly that it's not switched on yet, rather than displaying an address that bounces. |
| Control notifications | none | Master switch, per-nudge toggles, and the thresholds below. Hosts the Phase 10 opt-in. |
| Force sync all events | none | Clears `last_calendar_sync_at`, so the next run reconsiders every gig. The repair tool for "my calendar looks wrong". |
| Default reminder minutes | hardcoded 60 | Also `useDefault` — let a user who curates their own calendar defaults opt out entirely. |

## Added, because the code says they're missing

- **Account** — email, which Google account the calendar is connected to, sign
  out. Currently sign-out hides in the header and the connected account is
  invisible, which is why a wrong-account connection is so hard to diagnose.
- **App versions** — webapp / worker / schema. They exist only behind three
  taps on the wordmark; a user reporting a problem shouldn't need a secret.
- **Default gig duration** — Phase 9 made duration real; new gigs should be
  able to prefill the user's usual shift instead of "Not set" every time.
- **Currency.** `formatMoney` hardcodes USD. A gig tracker that can only speak
  dollars is a real limit, and the fix is one `Intl.NumberFormat` argument.
- **Nudge thresholds** — stale-lead days and unpaid days, currently constants
  in the push code. They are exactly the sort of number one person finds
  nagging and another finds too quiet.
- **Capture usage** — captures used today against `AI_DAILY_CAP`, so hitting
  the cap is explicable rather than mysterious.
- **Disconnect calendar** — move it here from the dashboard card, where it sits
  awkwardly next to a status line.

**Deliberately not settings:** anything with one defensible answer. Money stays
integer cents, IDs stay UUIDs, sync stays last-write-wins. A setting is a
promise to support both branches forever.

## Themes

**System / Light / Dark, defaulting to System.** Three options, not a toggle:
a phone that dims itself at night should take the app with it, and forcing a
choice on someone who has already told the OS their preference is rude.

**This is the one setting that does not sync.** Everything else belongs to the
person and rides in `settings_json`; a theme belongs to the *device and its
surroundings* — dark on the phone at a night shift, light on a laptop in
daylight. It lives in `localStorage`, and syncing it would actively work
against the user.

### What it actually costs, honestly

The design system says dark mode is "configured but no dark values exist", and
the code agrees: `darkMode: "class"` is set and **zero** `dark:` utilities are
used anywhere. The 27 semantic tokens (`--surface-card`, `--text-strong`, …)
are exactly the right abstraction — but the screens consume Tailwind utilities
(`bg-white`, `text-slate-900`), not those tokens, so defining dark values alone
changes nothing.

That gap is the consequence of a deliberate choice during the design-system
adoption: Tailwind was *not* routed through `var()` because it would have
broken the `/90` and `/95` alpha modifiers the sticky header and tab bar
depend on. Reversing that needs care rather than enthusiasm.

**Route taken:** express the palette in `tailwind.config.ts` as
`rgb(var(--token) / <alpha-value>)`, with tokens stored as raw channel
triplets (`--surface-card: 255 255 255`). Tailwind substitutes the alpha, so
`bg-white/90` keeps working and a single `data-theme="dark"` on the root
re-points every utility at once.

**Rejected:** sprinkling `dark:` variants across fourteen screens. It doubles
every colour decision, guarantees drift, and would put the design system's
"one accent, one radius" discipline back where it was before Phase 8.

### Details that bite

- **Apply before first paint.** A tiny inline script in `index.html` reads the
  stored choice and sets the root attribute. React state resolves too late and
  the user gets a white flash on every launch — worst on the installed PWA,
  which is the primary surface.
- **`theme-color` is declared twice** — `index.html` and the PWA manifest — and
  the design system already warns that a mismatch flashes the wrong colour
  during launch. Both must follow the theme, and the manifest's is static, so
  the meta tag is updated at runtime.
- **Audit the hand-written surfaces**, not just components: the `Splash`, the
  login sheet, and the hidden console all carry literal slate colours.
- **The design-token adherence test** pins token values against Tailwind's
  palette; restating them as channel triplets means that test changes shape and
  must keep asserting the same guarantee.

**No accent choice.** "One accent" is a stated design-system principle, not an
oversight — a picker would trade the app's coherence for a novelty.

## Decisions

- **Storage is one `settings_json` column on `users`**, not a column per
  setting and not a table. Settings will keep arriving; a JSON blob with a zod
  schema and defaults means adding one is a code change, not a migration. Reads
  go through `parseSettings()`, which fills defaults, so a row written by an
  older version is always valid.
- **Defaults live in one place** (`domain/settings.ts`) and are exported to
  both halves. The calendar sync and push nudges read the user's settings
  rather than constants, which is the whole point.
- **The screen is a normal route** (`/settings`, reached from the header), not
  a sixth tab — five is already the practical limit at 375px, and this is a
  place you visit rarely.
- **Force sync is explicit and confirmed.** It re-pushes every confirmed gig to
  Google; on a large history that is a lot of API calls, so it says so.
- **Nothing here bypasses the review gate.** Settings change future behaviour;
  they never rewrite existing records.

**Branch:** dev-17 (after the Phase 10 backend lands). No commits without the
user's command.

---

### Task 1: Settings storage + schema

**Files:** `migrations/0008_user_settings.sql`, `domain/settings.ts`, `repos/users.ts`, `routes/settings.ts`, tests

- [ ] RED: defaults returned for a user who has never saved; a partial save
      merges rather than replaces; unknown keys are rejected; an unparseable
      blob falls back to defaults instead of failing the request
- [ ] GREEN

### Task 2: Behaviour reads settings

- [ ] Calendar: title prefix, reminder minutes (and "use calendar default"),
      target calendar id
- [ ] Push: nudge thresholds and per-nudge enablement
- [ ] Gig form: default duration; money formatting: currency

### Task 3: Force sync + dedicated calendar

- [ ] `POST /api/calendar/resync` clears the watermark; confirmed in the UI
- [ ] Creating/selecting a Gigsy calendar, with the extra scope handled as a
      re-consent rather than a silent failure

### Task 4: Theming

**Files:** `tailwind.config.ts`, `src/styles/tokens/*.css`, `index.html`, `src/lib/theme.ts`, tests

- [ ] RED: the theme resolver maps system/light/dark to a root attribute and
      honours `prefers-color-scheme` only in system mode; the adherence test
      still pins token values after they become channel triplets
- [ ] GREEN: palette via `rgb(var(--token) / <alpha-value>)` so `/90` scrims
      survive; pre-paint inline script; `theme-color` updated at runtime
- [ ] Audit Splash, login sheet and hidden console for literal colours

### Task 5: The screen

- [ ] `/settings` built from design-system components; account, appearance,
      calendar, notifications, capture, app info; each section explains what it
      changes
- [ ] e2e: a setting persists across a reload; dark mode applies with no
      white flash on load

### Task 6: Docs + verification

- [ ] docs/plan.md §13 Phase 11; §4 note on `settings_json`
- [ ] Full sweep; tree left uncommitted pending the user's command
