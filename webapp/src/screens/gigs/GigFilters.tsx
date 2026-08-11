/**
 * The gig list's controls.
 *
 * Search and sort stay visible because they are the two things reached
 * for constantly; everything else sits behind a toggle, because on a
 * 375px phone a permanent filter panel costs more rows than it saves.
 *
 * The component owns no filter state — it renders what it is given and
 * hands back a whole next value. The state lives in the URL (see
 * Gigs.tsx), which is what makes a filter survive opening a gig.
 */
import { useState } from "react";
import { Button, Field, Input, Select } from "../../components/index.ts";
import {
  DEFAULT_FILTERS,
  GIG_SORTS,
  dateInputToMs,
  isFiltered,
  msToDateInput,
  type GigFilters as Filters,
  type GigSort,
} from "../../lib/gig-filters.ts";
import { GIG_STATUSES, type Client, type GigStatus } from "../../lib/types.ts";

const SORT_LABELS: Record<GigSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  amount: "Biggest amount",
  client: "Client A–Z",
};

export function GigFilters({
  filters,
  onChange,
  clients,
  shown,
  total,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  clients: readonly Client[];
  shown: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const filtered = isFiltered(filters);

  function toggleStatus(status: GigStatus) {
    const statuses = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status];
    onChange({ ...filters, statuses });
  }

  return (
    <section data-testid="gig-filters" className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="search"
          data-testid="gig-search"
          aria-label="Search gigs"
          placeholder="Search gigs"
          className="min-w-0 flex-1"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
        <Select
          data-testid="gig-sort"
          aria-label="Sort gigs"
          className="w-36 shrink-0"
          value={filters.sort}
          onChange={(e) => {
            const sort = e.target.value;
            const known = GIG_SORTS.find((s) => s === sort);
            onChange({ ...filters, sort: known ?? DEFAULT_FILTERS.sort });
          }}
        >
          {GIG_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          variant={filtered ? "soft" : "ghost"}
          size="sm"
          data-testid="gig-filters-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Filters
        </Button>
        {filtered && (
          <p data-testid="gig-filter-count" className="text-xs text-slate-500">
            Showing {shown} of {total}
          </p>
        )}
      </div>

      {open && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <div>
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Status
            </span>
            <div
              data-testid="gig-status-filter"
              role="group"
              aria-label="Filter by status"
              className="flex flex-wrap gap-2"
            >
              {GIG_STATUSES.map((status) => {
                const on = filters.statuses.includes(status);
                return (
                  <Button
                    key={status}
                    size="sm"
                    variant={on ? "soft" : "ghost"}
                    data-testid={`gig-status-${status}`}
                    aria-pressed={on}
                    onClick={() => toggleStatus(status)}
                  >
                    {status}
                  </Button>
                );
              })}
            </div>
          </div>

          <Field label="Client">
            <Select
              data-testid="gig-client-filter"
              aria-label="Filter by client"
              value={filters.clientId ?? ""}
              onChange={(e) =>
                onChange({
                  ...filters,
                  clientId: e.target.value === "" ? null : e.target.value,
                })
              }
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          {/* min-w-0 on the cells: a grid item's default min-width is
              auto, and a date input's intrinsic minimum is wide enough
              to push two of them past a narrow screen. */}
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <Field label="From">
              <Input
                type="date"
                data-testid="gig-from"
                aria-label="Gigs from date"
                value={msToDateInput(filters.from)}
                onChange={(e) =>
                  onChange({ ...filters, from: dateInputToMs(e.target.value, "start") })
                }
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                data-testid="gig-to"
                aria-label="Gigs to date"
                value={msToDateInput(filters.to)}
                onChange={(e) =>
                  onChange({ ...filters, to: dateInputToMs(e.target.value, "end") })
                }
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              data-testid="gig-hide-past"
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              checked={filters.hidePast}
              onChange={(e) => onChange({ ...filters, hidePast: e.target.checked })}
            />
            Hide past gigs
          </label>

          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="gig-filters-clear"
              // The sort survives: it is how you like the list read, not
              // a filter you set and forgot.
              onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}
            >
              Clear filters
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
