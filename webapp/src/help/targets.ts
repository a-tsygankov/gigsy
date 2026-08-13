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

/** CSS for Playwright. Exactly the locator e2e/settings.spec.ts proves
 *  against the real component. */
export function targetSelector(t: HelpTarget): string {
  return t.kind === "switch"
    ? `label:has([data-testid="${t.id}"]) span[aria-hidden="true"]`
    : `[data-testid="${t.id}"]`;
}

/** DOM for the tour. Walks rather than using `:has()`, so the spotlight
 *  never depends on selector support in an older mobile Safari. */
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
