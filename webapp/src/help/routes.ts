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
 * Deliberately not react-router's `matchPath`, and not for the reason
 * you might assume: that function is pure and runs fine in Node with no
 * DOM and no mounted Router — checked against this repo's own
 * node_modules, not guessed. The reasons are that it is
 * CASE-INSENSITIVE by default (`/Gigs/:id` matches `/gigs/abc` unless
 * every call site passes `{ caseSensitive: true }`), and that it
 * implements a far larger pattern language than a help scenario needs —
 * wildcards, optional segments, `pathnameBase` — whose semantics are
 * free to shift under a react-router upgrade. A tour torn down
 * mid-step because a matcher quietly got more generous is a bug nobody
 * would think to look for here.
 *
 * The subset a help scenario needs is one segment per ":param", and
 * that is all this implements: no wildcards, no optional segments, no
 * search or hash. Staying dependency-free also keeps react-router out
 * of the Playwright runner's module graph — `e2e/help/help-runner.ts`
 * imports this file — which is the same instinct that keeps types.ts
 * free of React.
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
    // got[i] is `string | undefined` under noUncheckedIndexedAccess, and
    // both branches below type-check either way — the compiler is not
    // what keeps this sound. The length check above is: it guarantees
    // every `i` in range here is also in range in `got`, so `got[i]` is
    // always a real segment, never `undefined`. A refactor that splits
    // this loop away from that check would break the invariant with no
    // type error to catch it.
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
 *  pathname.
 *
 *  Not deduplicated: a navigate step landing on the same pattern as
 *  another, or as `startRoute` itself, produces a repeated entry. The
 *  only consumer checks membership (`.some(p => matchesRoute(p, ...))`),
 *  where a duplicate is harmless, but the `string[]` return type does
 *  not say so — a caller that displays or counts these must dedupe
 *  itself. */
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
