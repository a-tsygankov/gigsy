/**
 * What help scenarios point at, and the one fact that makes them work:
 * how an element's test ID relates to the thing a person touches.
 *
 * Most interactive controls here are `Toggle`, which puts its test ID on
 * a `peer sr-only` input — one pixel square — while the switch you can
 * see is a sibling span. Highlighting the tagged node spotlights nothing,
 * and clicking it in a test passes while proving nothing a user could do.
 * The comment above `paintedSwitch` in e2e/settings.spec.ts is the same
 * lesson learned the expensive way.
 *
 * So kind is DECLARED, never derived from the name. The name lies in both
 * directions: `push-toggle` is a Button, and `toggle-prefix` is a switch
 * for a calendar title prefix.
 */

export type HelpTargetKind = "element" | "switch";

export interface HelpTarget {
  readonly id: string;
  readonly kind: HelpTargetKind;
}

const element = (id: string): HelpTarget => ({ id, kind: "element" });
const painted = (id: string): HelpTarget => ({ id, kind: "switch" });

/** Deliberately shares its name with the interface above — one is a type,
 *  the other a value, and `HelpTarget.SettingsLink` is how call sites
 *  want to read. */
export const HelpTarget = {
  SettingsLink: element("settings-link"),
  SettingsHelp: element("settings-help"),

  SettingsNotifications: element("settings-notifications"),
  // A <Button>, not a Toggle, despite the name — Settings.tsx:108.
  PushToggle: element("push-toggle"),
  PushUnavailable: element("push-unavailable"),

  SettingsCapture: element("settings-capture"),
  CaptureAddress: element("capture-address"),
  CaptureAddressValue: element("capture-address-value"),
  CaptureUnconfigured: element("capture-unconfigured"),

  SettingsAvailability: element("settings-availability"),
  AvailWorkingWeek: element("avail-working-week"),

  // A calendar *title prefix* switch — nothing to do with toggle naming.
  TogglePrefix: painted("toggle-prefix"),

  // ── the gig list (Gigs.tsx, gigs/GigFilters.tsx) ──
  // Three ids for three states, and the third exists because two of
  // them could not be told apart.
  //
  // `gig-list` is mounted only while at least one row is showing, which
  // is what lets a branch use it to mean "there is a gig here to open".
  // `gig-filters` is mounted whenever the user owns any gig at all
  // (`all.length > 0`), so the two together separate "gigs showing"
  // from "gigs, all filtered out".
  //
  // `gigs-empty` is the "No gigs yet" box, and what it adds is a
  // POSITIVE form of the third state. `all` is `gigs.data ?? []`, so
  // `all.length === 0` — and therefore a missing `gig-filters` — is
  // equally true while the gig query is still pending and after it has
  // errored. A branch reading `target-missing gig-filters` as "this
  // account owns no gigs" was right one time in three and wrong the
  // other two, which on a cold open meant telling somebody with several
  // hundred gigs that they had none. Gigs.tsx mounts this box on
  // `gigs.data?.length === 0` instead: resolved, and resolved to
  // nothing. Ask the screen what it is SAYING, not what it has not got
  // round to saying.
  //
  // The cost is that loading and errored now match no alternative at
  // all, and a branch with no winner is a hard failure in both adapters
  // (`settleBranch`, `resolveBranch`). That is the right trade. Loading
  // resolves well inside the 10s branch budget, and a gig list that
  // genuinely failed to load has no walkthrough to give — "help isn't
  // available right now" is true of that screen, and "there are no gigs
  // on this account" is not.
  //
  // What this does NOT do is make the answer infallible, and the hole
  // left is worth naming rather than discovering. Reads go to the local
  // store and never to the network (`OfflineDataService.listGigs`;
  // docs/plan.md §7), so a device part-way through its first pull
  // resolves to `[]` honestly, and Gigs.tsx renders this box. Help then
  // says there are no gigs because the SCREEN says there are no gigs —
  // which is exactly the contract this id exists to give. What is gone
  // is help contradicting a screen that was making no claim at all.
  // e2e/help/help-fixtures.ts's `waitForGigsToHydrate` still waits that
  // window out for the suite, and still has to.
  GigList: element("gig-list"),
  GigFilters: element("gig-filters"),
  GigsEmpty: element("gigs-empty"),
  GigSearch: element("gig-search"),
  GigFiltersToggle: element("gig-filters-toggle"),
  // The Fab is a <Link>, not a Button — an element either way.
  GigAdd: element("gig-add"),

  // ── the job form (GigEdit.tsx, `/gigs/new` and `/gigs/:id/edit`) ──
  // Every one of these is an Input, Select, Textarea or Button, so every
  // one is `element`. DateTimeField is one control now — a popover
  // trigger carrying the id it is given — so a moment is one target, not
  // a date target plus a time target. Its calendar and time input live
  // inside the popover and have no help targets at all: this scenario is
  // highlight-only (see scenarios/create-gig.ts's header), so it never
  // opens the popover, and a step aiming inside a closed one would wait
  // out `waitForElement` and fail the walk every run.
  // DurationField still splits, but only its hours half has a help
  // target — there is no separate scenario step for the minutes input.
  GigTitle: element("gig-title"),
  GigClient: element("gig-client"),
  GigDateTime: element("gig-datetime"),
  GigDurationHours: element("gig-duration-hours"),
  GigLocation: element("gig-location"),
  GigUseCurrentLocation: element("use-current-location"),
  GigPayType: element("gig-pay-type"),
  // No `GigRate` entry: gig-rate only exists once the pay-type select is
  // switched to hourly, and this scenario is highlight-only (see
  // create-gig.ts's header) — it never performs that switch, so a step
  // targeting gig-rate would wait out `waitForElement` and fail the walk
  // every run. GigOffered stays the one pay-amount step; it resolves
  // because the form loads with `payType: "fixed"` (GigEdit.tsx's
  // `BLANK`) and this highlight-only walkthrough never touches Paid by,
  // so Offered ($) — never Rate ($ per hour) — is what's on screen for
  // the whole run (see create-gig.ts's header for the full reasoning).
  GigOffered: element("gig-offered"),
  // No `GigPaid` entry either, and this one is gone for good rather
  // than conditional: the form's "Paid ($)" input was removed when
  // gigs.amountPaidCents became server-derived from payment
  // allocations. What has arrived is recorded payment by payment on
  // the detail hub — see GigEdit.tsx's header.
  GigNotes: element("gig-notes"),
  GigSave: element("gig-save"),

  // ── the detail hub (GigDetail.tsx, gigs/WorkCard.tsx) ──
  // `/gigs/:id`, which is where a row on the gig list now opens. None of
  // these exists on `/gigs/new`: they are all about a gig that has been
  // saved, which is why `create-gig` — a walk of the empty form — no
  // longer has steps for them (see that file's header). Reaching them
  // needs a scenario that starts on a saved gig, which Phase 3 Task 5
  // adds as `record-work`.
  //
  // The ids are unchanged from when these controls lived on the form, so
  // anything already pointing at them still resolves; what changed is
  // the screen they resolve on.
  GigEditButton: element("gig-edit"),
  // The Job card's "Pays" row — how the work is PRICED, as agreed,
  // which is a different statement from what it earned (that is
  // `GigExpectedPay`, on the work card). Unconditional: `payLine`
  // returns "Fixed fee — not set" or "Hourly — no rate set" rather
  // than rendering nothing, so this resolves on every gig.
  JobPay: element("job-pay"),
  GigStatus: element("gig-status"),
  GigWorkStartButton: element("work-start"),
  GigWorkStopButton: element("work-stop"),
  GigWorkStart: element("gig-work-start"),
  GigWorkEnd: element("gig-work-end"),
  GigBreak: element("gig-break"),
  GigExpectedPay: element("gig-expected-pay"),
  GigOverride: element("gig-override"),
  // Both are `<section>`s carrying the id themselves.
  GigServices: element("gig-services"),
  GigPayments: element("gig-payments"),

  // ── the additional-service form (ServiceEdit.tsx) ──
  ServiceDescription: element("service-description"),
  ServiceOffered: element("service-offered"),
  ServicePaid: element("service-paid"),
  ServicePayment: element("service-payment"),
  // A bare 16px <input type="checkbox">, NOT a Toggle — nothing is
  // sr-only here and there is no painted sibling to walk to, so this is
  // `element` (checked against ServiceEdit.tsx, per this file's rule).
  ServiceCompleted: element("service-completed"),
  ServiceSave: element("service-save"),

  // ── the payment form (PaymentEdit.tsx) ──
  PaymentAmount: element("payment-amount"),
  PaymentClient: element("payment-client"),
  // The FIRST split row's gig select. There is no longer a single
  // `payment-gig` — one payment can pay for several gigs, so the rows
  // are indexed (`payment-gig-0`, `payment-gig-1`, …) and a tour can
  // only ever point at the one that is always there.
  PaymentGig: element("payment-gig-0"),
  PaymentPaidAt: element("payment-paid-at"),
  PaymentNotes: element("payment-notes"),
  PaymentConfirmation: element("payment-confirmation"),
  PaymentSave: element("payment-save"),

  // ── the client form (ClientEdit.tsx) ──
  // Input, Textarea and Button — every one an `element`. `client-jobs`
  // and `client-delete` are deliberately absent: both are `!isNew`-only,
  // so neither exists on `/clients/new`, which is where `create-client`
  // starts and the only place a tour can walk this form without a saved
  // record to walk it on.
  ClientName: element("client-name"),
  ClientContact: element("client-contact"),
  ClientNotes: element("client-notes"),
  ClientSave: element("client-save"),

  // ── the expense form (ExpenseEdit.tsx) ──
  // `expense-reimbursable` is a bare 16px <input type="checkbox">, not a
  // Toggle — nothing is sr-only and there is no painted sibling to walk
  // to, so it is `element` like ServiceCompleted. Checked against
  // ExpenseEdit.tsx, per this file's rule.
  ExpenseAmount: element("expense-amount"),
  ExpenseCategory: element("expense-category"),
  ExpenseGig: element("expense-gig"),
  ExpenseNotes: element("expense-notes"),
  ExpenseReimbursable: element("expense-reimbursable"),
  ExpenseSave: element("expense-save"),

  // ── the calendar card (Dashboard.tsx's CalendarSection) ──
  // `calendar-section` is the whole <Card>; it is absent entirely while
  // the status query is loading or has failed, which is why
  // `connect-calendar` highlights it first and lets that step be the one
  // that waits.
  //
  // `calendar-action` is one <Button> whose label is "Connect" before
  // the calendar is linked and "Sync now" after — the id names the slot,
  // not either label, so it resolves in both states.
  //
  // `calendar-disconnect` only exists while connected, which is what
  // makes it a usable branch condition for "is this account linked".
  CalendarSection: element("calendar-section"),
  CalendarAction: element("calendar-action"),
  CalendarDisconnect: element("calendar-disconnect"),

  // ── photo capture (Capture.tsx) ──
  // NOT `capture-input`: that is the `type="file"` input, and it carries
  // `className="hidden"`. It cannot be spotlighted, and driving it would
  // mean a help scenario uploading a file — see scenarios/capture.ts.
  CaptureStart: element("capture-start"),
} as const;

export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Working-hours day switches are generated per weekday, so the target
 *  is too. AvailabilitySection.tsx renders `toggle-day-${index}`. */
export const dayToggle = (i: WeekdayIndex): HelpTarget =>
  painted(`toggle-day-${i}`);

/** The start-time select on a working-hours row. An `element`: Select
 *  renders a real <select> carrying the test ID. */
export const dayStart = (i: WeekdayIndex): HelpTarget =>
  element(`start-day-${i}`);

/** The CSS form of a target, for anything that needs a selector rather
 *  than a node: e2e/settings.spec.ts's locators, and — since the tour
 *  runtime landed — Driver.js's `element`, which must be a string so
 *  that `waitForElement` can re-query it as the DOM changes under a
 *  running tour (TourRenderer.ts).
 *
 *  So this is production code now, not test-only, and the old rationale
 *  for it ("a malformed selector fails a Playwright test, not
 *  production") no longer holds. What does hold is the reason it was
 *  never a real risk: `t.id` is never user input. Every id comes from a
 *  typed factory in this file or from a `WeekdayIndex` template, so no
 *  quote or bracket is reachable and there is nothing for an unescaped
 *  interpolation to break. Adding a target with a hand-written id
 *  containing anything outside `[A-Za-z0-9_-]` is what would change
 *  that — use `CSS.escape` here if it ever does.
 *
 *  Switch targets resolve through `:has()`, which is Safari 15.4+ and
 *  every current evergreen browser. That is a deliberate acceptance:
 *  the alternative is a node, and a node cannot survive the re-query
 *  that makes a not-yet-rendered target reachable. */
export function targetSelector(t: HelpTarget): string {
  return t.kind === "switch"
    ? `label:has([data-testid="${t.id}"]) span[aria-hidden="true"]`
    : `[data-testid="${t.id}"]`;
}

/** The resolved node behind a target, walked rather than selected.
 *
 *  Not the spotlight path: the spotlight is Driver.js's own, and it goes
 *  through `targetSelector` and therefore through `:has()`. This is what
 *  callers use when they need the element itself — today that is
 *  `conditionHolds` in TourRenderer.ts, which measures a branch
 *  condition's target for visibility and cannot do that to a selector
 *  string. The Playwright validator and the scenario generator will want
 *  the same thing, which is why walking stays: it is the one form that
 *  needs no selector-engine support at all. */
export function resolveTarget(t: HelpTarget): HTMLElement | null {
  const tagged = document.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(t.id)}"]`,
  );
  if (tagged === null) return null;
  if (t.kind === "element") return tagged;
  return (
    tagged
      .closest("label")
      ?.querySelector<HTMLElement>('span[aria-hidden="true"]') ?? null
  );
}
