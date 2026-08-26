/** @vitest-environment jsdom */

/**
 * The gig list has FOUR renders, not three, and for a while two help
 * scenarios could only see three.
 *
 * `find-a-gig` and `record-work` both open on `/gigs` and both start on
 * the same branch: gigs showing, gigs hidden by filters, or no gigs at
 * all. `no-gigs-yet` used to be `target-missing gig-filters` — and
 * Gigs.tsx mounts the filter bar on `all.length > 0`, where `all` is
 * `gigs.data ?? []`. That is empty in three of the four renders: no
 * gigs, query pending, query errored. So the branch that says "There
 * are no gigs on this account" also held while the list was loading and
 * after it had failed, and 250ms of debounce (`settleBranch`) is not a
 * cold sync. Somebody with several hundred gigs got told they had none.
 *
 * These tests are the fourth render, pinned. They drive the REAL
 * scenarios' real opening branch — not a hand-built stand-in — against
 * a DOM holding exactly what Gigs.tsx renders in each state, so a
 * condition that ever goes back to reading an absence fails here.
 *
 * Loading and errored are asserted to match NOTHING, which is the
 * deliberate half of the trade: no alternative holding is a hard
 * failure both adapters report as "help isn't available right now",
 * and that is the honest answer for a screen with nothing to walk. A
 * pending query resolves long inside the real 10s budget; the budget
 * here is short only so the test is.
 */
import { describe, expect, it } from "vitest";
import { expandBranch } from "../runtime/TourRenderer.ts";
import { findAGig } from "./find-a-gig.ts";
import { recordWork } from "./record-work.ts";
import type { BranchStep, HelpScenario } from "../types.ts";

/** jsdom computes no layout, so every rect is zero-sized and every
 *  target would read as invisible. Same stub TourRenderer.test.ts
 *  uses, widened to paint several ids at once — the states below are
 *  combinations, not single elements. */
function paint(...testIds: string[]): void {
  document.body.innerHTML = testIds
    .map((id) => `<div data-testid="${id}"></div>`)
    .join("");
  for (const id of testIds) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    el!.getBoundingClientRect = () =>
      ({
        width: 40,
        height: 40,
        top: 0,
        left: 0,
        right: 40,
        bottom: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

function openingBranch(scenario: HelpScenario): BranchStep {
  const first = scenario.steps[0];
  if (first === undefined || first.action !== "branch") {
    throw new Error(`${scenario.id} no longer opens on a branch step`);
  }
  return first;
}

/** The first step of a named alternative, used as its fingerprint:
 *  `expandBranch` returns the very objects the scenario declares, so
 *  identity is enough and says which alternative was taken without
 *  restating its contents. */
function firstStepOf(scenario: HelpScenario, branchId: string): unknown {
  const branch = openingBranch(scenario).branches.find((b) => b.id === branchId);
  if (branch === undefined) {
    throw new Error(`${scenario.id} has no branch "${branchId}"`);
  }
  return branch.steps[0];
}

/** The opening branch alone — not the whole scenario. `record-work`
 *  has two more branches after a navigate step, and they ask about a
 *  gig's own screen, which no DOM here is. */
async function resolveOpening(scenario: HelpScenario) {
  return expandBranch([openingBranch(scenario)], new AbortController().signal, 400, 50);
}

const SCENARIOS: HelpScenario[] = [findAGig, recordWork];

describe.each(SCENARIOS.map((s) => [s.id, s] as const))(
  "%s — the opening branch against every render of /gigs",
  (_id, scenario) => {
    it("takes no-gigs-yet when the screen is actually saying there are no gigs", async () => {
      // Gigs.tsx on `gigs.data?.length === 0`: the empty state, and
      // no filter bar, because `all.length > 0` is false.
      paint("gigs-empty");
      const taken = await resolveOpening(scenario);
      expect(taken?.flat[0]).toBe(firstStepOf(scenario, "no-gigs-yet"));
    });

    it("takes nothing while the gig query is still pending", async () => {
      // `gigs.isPending` — a ListSkeleton, and nothing else. The
      // regression: this used to satisfy `target-missing gig-filters`
      // and commit to no-gigs-yet on an account full of gigs.
      paint("skeleton");
      await expect(resolveOpening(scenario)).resolves.toBeNull();
    });

    it("takes nothing when the gig query has errored", async () => {
      // `gigs.isError` — the "Couldn't load gigs" line carries no test
      // id at all, so this state paints nothing a target can reach.
      paint();
      await expect(resolveOpening(scenario)).resolves.toBeNull();
    });

    it("takes gigs-showing when rows are on screen", async () => {
      paint("gig-filters", "gig-list");
      const taken = await resolveOpening(scenario);
      expect(taken?.flat[0]).toBe(firstStepOf(scenario, "gigs-showing"));
    });

    it("takes gigs-hidden-by-filters when the account has gigs but none survive", async () => {
      paint("gig-filters");
      const taken = await resolveOpening(scenario);
      expect(taken?.flat[0]).toBe(firstStepOf(scenario, "gigs-hidden-by-filters"));
    });
  },
);
