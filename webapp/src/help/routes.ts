/**
 * Route patterns, as plain data.
 *
 * A `navigate` step names where the user's tap lands, and three places
 * need to agree about what that name means: HelpProvider, which decides
 * whether a route change is the declared hop or someone walking out on
 * the tour; the Playwright runner, which waits for the URL; and anyone
 * reading a scenario. One definition here rather than three regexes
 * that drift.
 *
 * Deliberately not react-router's own matcher. This module is imported
 * by `e2e/help/help-runner.ts`, which runs under Playwright in Node
 * with no router and no DOM — the same reason types.ts holds no React.
 * The subset a help scenario needs is one segment per ":param", and
 * that is all this implements: no wildcards, no optional segments, no
 * search or hash.
 */
import type { HelpScenario, HelpStep } from "./types.ts";

/** Segment-by-segment, never `startsWith`: "/gigs" must not match
 *  "/gigsy", and "/gigs/:id" must not match "/gigs/abc/edit". Splitting
 *  on "/" makes both fall out of a length check plus a per-segment
 *  comparison, with no escaping to get wrong — `pattern` comes from a
 *  scenario file and `pathname` from the router, and neither is ever
 *  compiled into anything, so there is no injection surface here at
 *  all. */
export function matchesRoute(pattern: string, pathname: string): boolean {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, i) =>
    // A param matches one NON-EMPTY segment: "/gigs/" is not a gig.
    segment.startsWith(":") ? got[i] !== "" : segment === got[i],
  );
}

/** Every route a running scenario may legitimately be on: where it
 *  starts, plus wherever each of its navigate steps lands — branches
 *  included, since that is where `record-work`'s own navigate step
 *  lives.
 *
 *  `fallback` is what a scenario with no `startRoute` starts on, which
 *  is wherever the user already was. HelpProvider passes its current
 *  pathname. */
export function allowedRoutes(scenario: HelpScenario, fallback: string): string[] {
  const routes = [scenario.startRoute ?? fallback];

  const walk = (steps: HelpStep[]): void => {
    for (const step of steps) {
      if (step.action === "branch") {
        for (const branch of step.branches) walk(branch.steps);
        continue;
      }
      if (step.action === "navigate") routes.push(step.route);
    }
  };
  walk(scenario.steps);

  return routes;
}
