/**
 * The list of help topics. Semantic buttons and a real text input, so
 * the whole thing works from a keyboard.
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

function matches(scenario: HelpScenario, query: string): boolean {
  if (query === "") return true;
  const haystack = `${scenario.title} ${scenario.description ?? ""}`;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

export function HelpMenu() {
  const { startScenario, unavailable, dismissUnavailable } = useHelp();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const found = helpScenarios.filter((s) => matches(s, query.trim()));
    const categories = [...new Set(found.map((s) => s.category))];
    return categories.map((category) => ({
      category,
      scenarios: found.filter((s) => s.category === category),
    }));
  }, [query]);

  return (
    <div className="space-y-3 py-3">
      {unavailable !== null && (
        // Same shell as Settings.tsx's own save-error banner
        // (`settings-save-error`), amber rather than red because this is
        // a "try something else" notice, not a failed write.
        <div
          className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
          role="status"
          data-testid="help-unavailable"
        >
          {unavailable}{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={dismissUnavailable}
          >
            Dismiss
          </button>
        </div>
      )}

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
