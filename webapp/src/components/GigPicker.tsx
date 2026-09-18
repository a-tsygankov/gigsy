/**
 * Choosing one gig out of hundreds (design system, components/core/
 * GigPicker; docs/superpowers/specs/2026-09-18-gig-picker-design.md).
 *
 * Three screens ask this question — which gig a payment split pays
 * for, which job a gig is part of, which gig an expense belongs to —
 * and all three used to answer it with a native `<select>`, each with
 * its own one-line label. With two hundred gigs a dropdown is
 * unusable, and a recurring job ("Arrange a tasting") appears many
 * times for different clients and dates, so a one-line option cannot
 * be told apart from its neighbours.
 *
 * The Gigs tab already solved finding: search, status, client, date
 * range, hide-past and four sorts, all pure helpers in
 * lib/gig-filters.ts with `GigFilters` as their controls. So the
 * picker is a trigger styled like an input, opening a full-screen
 * `Sheet` that holds those same controls over the caller's candidate
 * list, with one `GigRow` per match. Nothing about finding a gig is
 * reinvented here; what is new is only the trigger and the sheet.
 *
 * What the picker deliberately does NOT own:
 *
 *   - Which gigs are eligible. The caller passes `gigs` already
 *     narrowed (GigEdit's parent rules, PaymentEdit's client), because
 *     each screen's rule is an echo of a server invariant that screen
 *     is responsible for. The picker never decides.
 *   - The filter state. It is local to the open sheet and reset on
 *     every open — not the URL, not the saved gig-list view. Picking a
 *     gig is a moment, not a place, and a search typed to find one
 *     parent must not narrow the next payment's split.
 *   - A default placeholder. "Not linked", "Not part of anything" and
 *     "Choose a gig…" mean different things, so the caller says which.
 *
 * `GigFilters` is a screen component (screens/gigs/GigFilters.tsx)
 * imported by a design-system one, which is the wrong direction for
 * the dependency and is accepted on purpose: moving it would touch
 * the Gigs tab, its tests and three help targets for no change in
 * behaviour, and the picker is the second and last caller. Its test
 * ids (`gig-search`, `gig-filters-toggle`, …) are therefore the same
 * inside the sheet as on the tab — scope a lookup to the sheet.
 */
import { useMemo, useState } from "react";
import { GigFilters } from "../screens/gigs/GigFilters.tsx";
import { Button } from "./Button.tsx";
import { cardClasses } from "./Card.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { GigRow, gigSummary } from "./GigRow.tsx";
import { inputShellClasses } from "./Input.tsx";
import { Sheet } from "./Sheet.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { DEFAULT_FILTERS, applyGigFilters, type GigFilters as Filters } from "../lib/gig-filters.ts";
import { isPaid } from "../lib/gig-pay.ts";
import type { Client, Gig } from "../lib/types.ts";

export interface GigPickerProps {
  /** Eligible gigs, already narrowed by the caller. */
  gigs: readonly Gig[];
  clients: readonly Client[];
  /** Selected gig id, "" for none. */
  value: string;
  onChange: (id: string) => void;
  /** Trigger testid. The sheet suffixes it: `-sheet` (the dialog;
   *  `-sheet-close` is its Close button), `-list`, `-none`,
   *  `-row-<id>`, `-clear`, and `-blocked` for the disabled reason.
   *  The filter bar inside keeps `GigFilters`' own ids. */
  testId: string;
  /** Accessible name and the sheet's heading. */
  label: string;
  /** Shown on the trigger when nothing is chosen. */
  placeholder: string;
  /** Renders the trigger disabled and explains why beneath it. */
  disabledReason?: string | null;
  /** Whether the "none" choice is offered inside the sheet. Default
   *  true. */
  allowNone?: boolean;
}

/** What the trigger says about a chosen id the candidate list does not
 *  hold. A parent this device has not pulled yet, a gig deleted since
 *  the expense was saved: the id is kept (saving must not silently
 *  unlink — see GigEdit.tsx's client-change effect), so the trigger
 *  has to say something true about a gig it cannot show. */
const UNKNOWN_GIG = "A gig this device hasn't loaded yet";

export function GigPicker({
  gigs,
  clients,
  value,
  onChange,
  testId,
  label,
  placeholder,
  disabledReason = null,
  allowNone = true,
}: GigPickerProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  const clientNames = useMemo(
    () => new Map(clients.map((c) => [c.id, c.name])),
    [clients],
  );
  const nameOf = (clientId: string | null): string | null =>
    clientId === null ? null : (clientNames.get(clientId) ?? null);

  const chosen = value === "" ? null : (gigs.find((g) => g.id === value) ?? null);
  const summary = chosen === null ? null : gigSummary(chosen, nameOf(chosen.clientId));

  // What a screen reader hears, and the same rule DateTimeField's
  // trigger follows: the field's name AND its value, explicitly.
  // `Field` wraps this in a <label>, and a wrapping label outranks a
  // button's own contents in the accessible-name algorithm — so
  // without this the button announces "Linked gig" and the gig is
  // simply absent.
  const spoken =
    summary !== null
      ? `${summary.heading}, ${summary.sub}`
      : value !== ""
        ? UNKNOWN_GIG
        : placeholder;

  const visible = applyGigFilters(gigs, filters, clientNames, Date.now());
  const disabled = disabledReason !== null && disabledReason !== "";

  function openSheet() {
    // Fresh filters on every open — see the header. The sort included:
    // the tab keeps a sort across a Clear because it is "how you like
    // the list read", but a picker has no list you keep coming back to.
    setFilters(DEFAULT_FILTERS);
    setOpen(true);
  }

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        // The canonical value beside the human one, as DateTimeField
        // does: what the trigger READS is a title and a localised date,
        // which is not something a test can assert a stored id against.
        data-value={value}
        aria-label={`${label}, ${spoken}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={openSheet}
        // A column once a gig is chosen (name row over details row);
        // a row while empty, so the placeholder and chevron sit on one
        // line the way DateTimeField's "No date yet" does.
        className={`${inputShellClasses} flex text-left disabled:cursor-not-allowed disabled:opacity-60 ${
          summary !== null
            ? "flex-col items-stretch"
            : "items-center justify-between gap-2"
        }`}
      >
        {summary !== null && chosen !== null ? (
          <>
            {/* The same two lines the Gigs tab row shows, so the gig
                you picked reads the way it did in the list you picked
                it from. Spans, not <p>s: a button may not hold block
                content.

                Stacked, not side by side. The row layout (name and
                sub-line left, pill and chevron right) left the NAME
                sharing its width with the pill, and inside a payment
                split row — a picker beside an amount box — that came
                out as "Tasting …" with the pill taking half the card.
                The name is the one thing that tells two gigs apart, so
                it gets the whole width and only the chevron beside it;
                the pill joins the details underneath, where it wraps
                with them when the card is narrow. */}
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-slate-900">
                {summary.heading}
              </span>
              <Chevron />
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <StatusPill status={chosen.status} paid={isPaid(chosen)} />
              <span className="min-w-0">{summary.sub}</span>
            </span>
          </>
        ) : (
          <>
            <span className={value === "" ? "text-slate-400" : "text-slate-500"}>{spoken}</span>
            <Chevron />
          </>
        )}
      </button>
      {disabled && (
        <span data-testid={`${testId}-blocked`} className="mt-1 block text-xs text-slate-500">
          {disabledReason}
        </span>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title={label} testId={`${testId}-sheet`}>
        <div className="mx-auto max-w-lg space-y-3">
          {/* Same gate as the Gigs tab: nothing to narrow, no filter
              bar. The bar's own `open` state is local to it, so the
              filter panel is folded on every open of the sheet. */}
          {gigs.length > 0 && (
            <GigFilters
              filters={filters}
              onChange={setFilters}
              clients={clients}
              shown={visible.length}
              total={gigs.length}
            />
          )}

          {gigs.length === 0 && (
            // The caller passed nothing. Different from "filtered out":
            // there is no filter to widen, and the useful fact is that
            // the screen offers no candidate at all.
            <EmptyState compact title="No gigs to choose from" />
          )}

          {(allowNone || visible.length > 0) && (
            <div className="space-y-3" data-testid={`${testId}-list`}>
              {allowNone && (
                <button
                  type="button"
                  data-testid={`${testId}-none`}
                  aria-pressed={value === ""}
                  onClick={() => pick("")}
                  // The card recipe GigRow's button mode uses, so the
                  // "none" choice sits in the list as one more row
                  // rather than as a control above it.
                  className={cardClasses({
                    interactive: true,
                    className: `w-full text-left text-sm text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      value === "" ? "border-emerald-500 ring-2 ring-emerald-500" : ""
                    }`,
                  })}
                >
                  {placeholder}
                </button>
              )}
              {visible.map((gig) => (
                <GigRow
                  key={gig.id}
                  gig={gig}
                  clientName={nameOf(gig.clientId)}
                  selected={gig.id === value}
                  testId={`${testId}-row-${gig.id}`}
                  onSelect={() => pick(gig.id)}
                />
              ))}
            </div>
          )}

          {gigs.length > 0 && visible.length === 0 && (
            <div className="space-y-3">
              {/* Mirrors the tab's wording. The Clear button is here
                  rather than only inside the folded filter panel,
                  because a search that matched nothing is the common
                  way to arrive at this state and the panel is closed. */}
              <EmptyState
                title="No gigs match these filters"
                hint="Try a wider date range, or clear the filters."
              />
              <Button
                variant="ghost"
                block
                data-testid={`${testId}-clear`}
                onClick={() => setFilters(DEFAULT_FILTERS)}
              >
                Clear filters
              </Button>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}

/** The same glyph DateTimeField's trigger ends with, so the two
 *  "tap to open" fields on a form read as the same kind of thing. */
function Chevron() {
  return (
    <span aria-hidden="true" className="shrink-0 text-slate-400">
      ⌄
    </span>
  );
}
