/**
 * The list of help topics. Semantic buttons and a real text input, so
 * the whole thing works from a keyboard.
 *
 * Does not render `unavailable` itself — a failed scenario can have
 * navigated the user off whatever screen this menu lives on before it
 * fails, so that message is HelpUnavailableBanner's job, rendered by
 * HelpProvider at the app root instead. See that file's doc comment.
 */
import { useMemo, useState } from "react";
import { Button, Input } from "../../components/index.ts";
import { helpScenarios } from "../registry.ts";
import type { HelpCategory, HelpScenario } from "../types.ts";
import { useHelp } from "./HelpProvider.tsx";

const CATEGORY_LABELS: Record<HelpCategory, string> = {
  "getting-started": "Getting started",
  settings: "Settings",
  installation: "Installing Gigsy",
};

/** `query` is expected pre-trimmed — callers normalize once, at the
 *  point they also decide what counts as "no query". */
export function matches(scenario: HelpScenario, query: string): boolean {
  if (query === "") return true;
  const haystack = `${scenario.title} ${scenario.description ?? ""}`;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

export interface HelpMenuGroup {
  category: HelpCategory;
  scenarios: HelpScenario[];
}

/** Matching scenarios, grouped and ordered.
 *
 *  Section order follows `CATEGORY_LABELS`' own key order, not first
 *  occurrence in `scenarios` — deriving order from the array would
 *  silently follow registration order the moment a `getting-started`
 *  scenario is added after `settings` ones, since both already exist
 *  today and happen to agree by accident.
 *
 *  One pass to bucket, one pass over the (fixed, small) category list
 *  to assemble the result — replaces what used to be a filter, a `Set`
 *  for category discovery, and a second filter per category.
 *
 *  `scenarios` defaults to the real registry but takes a parameter so
 *  ordering and matching can be tested against a small fixture instead
 *  of whatever happens to be registered today — the same reason
 *  `TourRenderer.ts`'s `flatten` takes `steps` rather than reading a
 *  module-level list. */
export function groupScenarios(
  query: string,
  scenarios: HelpScenario[] = helpScenarios,
): HelpMenuGroup[] {
  const q = query.trim();
  const byCategory = new Map<HelpCategory, HelpScenario[]>();
  for (const scenario of scenarios) {
    if (!matches(scenario, q)) continue;
    const bucket = byCategory.get(scenario.category);
    if (bucket === undefined) byCategory.set(scenario.category, [scenario]);
    else bucket.push(scenario);
  }
  return (Object.keys(CATEGORY_LABELS) as HelpCategory[])
    .map((category) => ({ category, scenarios: byCategory.get(category) ?? [] }))
    .filter((group) => group.scenarios.length > 0);
}

export function HelpMenu() {
  const { startScenario } = useHelp();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => groupScenarios(query), [query]);

  return (
    <div className="space-y-3 py-3">
      <Input
        type="search"
        value={query}
        aria-label="Search help topics"
        placeholder="Search help"
        data-testid="help-search"
        onChange={(e) => setQuery(e.target.value)}
      />

      {grouped.length === 0 && (
        <p className="text-xs text-slate-500">No help topic matches that.</p>
      )}

      {grouped.map(({ category, scenarios }) => (
        <div key={category} className="space-y-1">
          <p className="text-xs font-semibold text-slate-500">
            {CATEGORY_LABELS[category]}
          </p>
          {scenarios.map((scenario) => (
            <Button
              key={scenario.id}
              variant="ghost"
              // `block`, not a justify override: Button's base class sets
              // justify-center, and two equal-specificity Tailwind
              // utilities would be decided by stylesheet order.
              block
              data-testid={`help-start-${scenario.id}`}
              onClick={() => void startScenario(scenario.id)}
            >
              {scenario.title}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}
