# Client self-update — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** an open app notices a new version has shipped and offers to
update itself, instead of staying on the old one until every tab closes.

**Where it stands today:** `registerSW.js` (generated) registers the
worker and does nothing else. `sw.ts` calls `self.skipWaiting()` and
`clientsClaim()` unconditionally, so a new worker seizes control the
moment the browser finds one — but the page keeps running the **old JS
bundle** until a reload. The browser only looks for a new `sw.js` on
navigation or roughly every 24h. So a PWA left open for days never
learns anything shipped.

That combination also has a latent hazard: the new worker serves assets
to a page running the old bundle, so a lazy chunk the new precache
dropped can 404 mid-session.

**Decisions already taken** (do not re-litigate):
- **A dismissible bar**, not a silent reload. Gig and expense forms hold
  their state in React until Save, and reloading under someone loses
  what they were typing — which gets reported as "the app lost my data".
- **Check on launch and on focus.** No periodic polling, no manual
  button in Settings.
- **Reload only the tab that applied.** Another tab applying leaves this
  one on the old bundle, which is the lesser evil against reloading a
  window someone is typing in.

**Architecture:** the state machine is a pure module with injected
effects, because this repo has no React Testing Library and no jsdom —
anything worth testing has to be testable without a DOM. The browser
glue that imports `virtual:pwa-register` holds no logic.

---

## Task 1: The state machine (pure)

**Files:** create `webapp/src/lib/pwa-update.ts` and
`webapp/src/lib/pwa-update.test.ts`.

- [x] **Step 1: Write the failing test.** Cover: starts idle;
      `markReady` → ready; `dismiss` → dismissed; a *newer* update after
      a dismiss prompts again; `apply` calls skipWaiting once even when
      called twice; `apply` from idle does nothing; a controller change
      reloads only when this tab applied; subscribers are notified and
      can unsubscribe.

- [x] **Step 2:** `cd webapp; npx vitest run src/lib/pwa-update.test.ts`
      → FAIL (module missing).

- [x] **Step 3: Implement** `createUpdateStore({ skipWaiting, reload })`
      returning `{ subscribe, getSnapshot, markReady, dismiss, apply,
      onControllerChange }`. `getSnapshot` returns a string so
      `useSyncExternalStore` sees a stable value.

- [x] **Step 4:** Run again → PASS.

- [x] **Step 5: Commit.**

---

## Task 2: The worker waits to be asked

**Files:** modify `webapp/src/sw.ts`, `webapp/vite.config.ts`.

- [x] **Step 1:** In `sw.ts`, delete the unconditional
      `self.skipWaiting()` and add a `message` listener that calls it on
      `{ type: "SKIP_WAITING" }`. Keep `clientsClaim()`, keep
      `precacheAndRoute` and the navigation fallback — both load-bearing
      for offline launch.

- [x] **Step 2:** In `vite.config.ts`, set `registerType: "prompt"` and
      `injectRegister: null`, so registration comes from our own module
      rather than the generated script.

- [x] **Step 3:** `pnpm build`, then confirm `dist/sw.js` still contains
      the precache manifest and that `dist/registerSW.js` is **gone**.

- [x] **Step 4: Commit.**

---

## Task 3: Browser glue + the bar

**Files:** create `webapp/src/lib/pwa-update-browser.ts`,
`webapp/src/components/UpdateBar.tsx`; modify
`webapp/src/components/index.ts`, `webapp/src/main.tsx`,
`webapp/src/App.tsx`.

- [x] **Step 1:** Glue module: import `registerSW` from
      `virtual:pwa-register`, wire `onNeedRefresh` → `markReady`, keep
      the registration from `onRegisteredSW`, and call
      `registration.update()` on start and whenever the document becomes
      visible. Add `/// <reference types="vite-plugin-pwa/client" />`.

      **Done differently.** `virtual:pwa-register` failed the build:
      it needs `workbox-window`, which this project does not have. The
      module registers through `navigator.serviceWorker` directly
      instead — about twenty lines, no new dependency, and it makes the
      first-install case explicit rather than implicit. That case
      matters: an installed-and-waiting worker with **no controller** is
      a first install, not an update, and offering to reload there would
      be the cry-wolf Task 4 Step 1 guards against.

- [x] **Step 2:** `UpdateBar` reads the store through
      `useSyncExternalStore`, renders nothing unless the state is
      `ready`, and offers Reload plus a dismiss control with an
      accessible name.

- [x] **Step 3:** Render it at the App root so it appears on every
      screen, including login. Start the glue from `main.tsx`.

- [x] **Step 4:** `pnpm typecheck` and `npx vitest run` → green.

- [x] **Step 5: Commit.**

---

## Task 4: Prove it did not break offline, and does not cry wolf

- [x] **Step 1:** E2E asserting the bar is **absent** on a normal load.
      A false "update available" is worse than no bar at all.

- [x] **Step 2:** Run the full Playwright suite, and specifically
      `offline-shell.spec.ts` — it builds for production and checks the
      installed app opens with no connectivity. **That spec passing is
      the real guard on this change**, because everything risky here is
      in the service worker rather than in the bar.

- [x] **Step 3:** Verify by hand in a browser that the bar appears when
      a waiting worker exists, and that Reload swaps to the new bundle.

- [x] **Step 4: Commit.**

---

## Known trade-off, recorded so it is not rediscovered

A dismissed bar means a stale app: the update waits until every tab
closes. A fresh launch still activates immediately, because there is no
controlled page to wait for — so the installed-PWA case is unchanged.
That is the price of not reloading under someone mid-sentence, and it
was chosen deliberately.
