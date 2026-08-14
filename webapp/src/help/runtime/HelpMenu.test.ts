import { describe, expect, it } from "vitest";
import type { HelpScenario } from "../types.ts";
import { groupScenarios, matches } from "./HelpMenu.tsx";

/** Minimal, valid-enough scenarios for exercising search and grouping —
 *  deliberately not the real registry, so ordering and matching are
 *  tested against a fixture that can put categories in the "wrong"
 *  order and never has to change when a real scenario is added or
 *  renamed (the same reason TourRenderer.test.ts builds its own
 *  HelpStep fixtures rather than importing the registry). */
function scenario(overrides: Partial<HelpScenario> & Pick<HelpScenario, "id">): HelpScenario {
  return {
    title: overrides.id,
    category: "settings",
    steps: [],
    ...overrides,
  };
}

describe("matches", () => {
  it("matches everything on an empty query", () => {
    expect(matches(scenario({ id: "a", title: "Anything" }), "")).toBe(true);
  });

  it("matches the title case-insensitively", () => {
    expect(matches(scenario({ id: "a", title: "Turn on Notifications" }), "notif")).toBe(true);
  });

  it("matches the description case-insensitively", () => {
    const s = scenario({ id: "a", title: "Title", description: "A nudge when a lead goes cold" });
    expect(matches(s, "LEAD")).toBe(true);
  });

  it("does not match a scenario with no description on a query that isn't in the title", () => {
    expect(matches(scenario({ id: "a", title: "Open Settings" }), "notifications")).toBe(false);
  });
});

describe("groupScenarios", () => {
  const fixture: HelpScenario[] = [
    // Deliberately registered out of CATEGORY_LABELS order — installation
    // first, settings second, getting-started last — so an ordering bug
    // that derives section order from array position instead of the
    // label map would be caught here.
    scenario({ id: "install", title: "Install Gigsy", category: "installation" }),
    scenario({ id: "notifications", title: "Turn on notifications", category: "settings" }),
    scenario({ id: "availability", title: "Share your availability", category: "settings" }),
    scenario({ id: "first-gig", title: "Log your first gig", category: "getting-started" }),
  ];

  it("orders sections getting-started, settings, installation regardless of registration order", () => {
    expect(groupScenarios("", fixture).map((g) => g.category)).toEqual([
      "getting-started",
      "settings",
      "installation",
    ]);
  });

  it("keeps same-category scenarios in their registered order within a section", () => {
    const settings = groupScenarios("", fixture).find((g) => g.category === "settings");
    expect(settings?.scenarios.map((s) => s.id)).toEqual(["notifications", "availability"]);
  });

  it("omits a category with no matching scenarios", () => {
    const groups = groupScenarios("install", fixture);
    expect(groups.map((g) => g.category)).toEqual(["installation"]);
  });

  it("returns nothing when no scenario matches", () => {
    expect(groupScenarios("no such topic", fixture)).toEqual([]);
  });

  it("trims the query before matching", () => {
    const groups = groupScenarios("  notifications  ", fixture);
    expect(groups.flatMap((g) => g.scenarios.map((s) => s.id))).toEqual(["notifications"]);
  });
});
