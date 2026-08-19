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
  // `gig-list` is mounted only while at least one row is showing, which
  // is what lets a branch use it to mean "there is a gig here to open".
  // `gig-filters` is mounted whenever the user owns any gig at all, so
  // the two together separate "no gigs" from "gigs, all filtered out".
  GigList: element("gig-list"),
  GigFilters: element("gig-filters"),
  GigSearch: element("gig-search"),
  GigFiltersToggle: element("gig-filters-toggle"),
  // The Fab is a <Link>, not a Button — an element either way.
  GigAdd: element("gig-add"),

  // ── the gig form (GigEdit.tsx) ──
  // Every one of these is an Input, Select, Textarea or Button, so every
  // one is `element`. DateTimeField splits one labelled field across two
  // controls and suffixes the id it is given, hence the two entries.
  // DurationField does the same, but only its hours half has a help
  // target — there is no separate scenario step for the minutes input.
  GigTitle: element("gig-title"),
  GigClient: element("gig-client"),
  GigStatus: element("gig-status"),
  GigDate: element("gig-datetime-date"),
  GigTime: element("gig-datetime-time"),
  GigDurationHours: element("gig-duration-hours"),
  GigLocation: element("gig-location"),
  GigUseCurrentLocation: element("use-current-location"),
  GigOffered: element("gig-offered"),
  GigPaid: element("gig-paid"),
  GigNotes: element("gig-notes"),
  GigSave: element("gig-save"),
  // The two blocks below the save button. Both are `<section>`s carrying
  // the id themselves, and GigEdit.tsx renders them in BOTH states — the
  // real list plus its "+ Add …" link on a saved gig, a paragraph
  // explaining what they are for on `/gigs/new`. That is what lets one
  // target work on a gig that does not exist yet, which is the only way
  // a tour can explain either feature: a tour cannot save a gig first.
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
  PaymentGig: element("payment-gig"),
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
