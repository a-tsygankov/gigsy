import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { formatMoney } from "../lib/format.ts";
import { formatLocalMoment } from "../lib/datetime.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import { isPaid, storedOrDerivedExpectedCents } from "../lib/gig-pay.ts";
import { useSettings } from "./settings/useSettings.ts";
import {
  applyGigFilters,
  filtersFromSettings,
  hasFilterParams,
  parseGigFilters,
  settingsPatchFromFilters,
  toSearchParams,
  type GigFilters as Filters,
} from "../lib/gig-filters.ts";
import { GigFilters } from "./gigs/GigFilters.tsx";
import {
  AppHeader,
  CardLink,
  EmptyState,
  Fab,
  ListSkeleton,
  StatusPill,
} from "../components/index.ts";

function dateLine(ms: number | null): string {
  // Same formatter DateTimeField's trigger uses, so the line you read
  // in the list and the line you read on the form are the same line.
  return ms === null ? "No date yet" : formatLocalMoment(ms);
}

export function Gigs() {
  const api = useData();
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.listClients(),
  });
  const clientName = new Map(clients.data?.map((c) => [c.id, c.name]) ?? []);
  const sync = useSyncState();
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: ["pending-gig-ids"],
    queryFn: () => api.pendingGigIds(),
    // The outbox is local and cheap to read, and a stale answer here
    // marks the wrong gig.
    staleTime: 0,
  });

  // The count is a size, not a revision — 1 means "one op pending",
  // not "the first op". Keying the query on it re-served a cached id
  // set whenever the count returned to a value it had held before, so
  // the dot could sit on a gig that had already synced.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["pending-gig-ids"] });
  }, [sync?.pendingCount, queryClient]);

  // In the URL, not in state: a filter that evaporates the moment you
  // open a gig and come back is not worth setting in the first place.
  const [params, setParams] = useSearchParams();
  const filters = parseGigFilters(params);

  // ...and in settings, so it also survives closing the app and follows
  // the user to another device. The URL stays the working state; these
  // are only the seed.
  const { settings, update } = useSettings();

  /**
   * Restore the saved view — once, and only into an empty URL.
   *
   * "Once" is not an optimisation. Without the guard, clearing every
   * filter empties the URL, the effect sees an empty URL, and it puts
   * the saved view straight back: the Clear button would visibly fail.
   * After the first pass the URL is authoritative for this session.
   *
   * "Only into an empty URL" is what keeps a shared link meaning what
   * it says. Someone opening ?status=lead asked for leads, whatever
   * this user last left on screen.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || settings === undefined) return;
    seeded.current = true;
    if (hasFilterParams(params)) return;
    const saved = toSearchParams(filtersFromSettings(settings, Date.now()));
    // Nothing worth restoring is not the same as restoring nothing —
    // skip rather than push an identical empty URL.
    if (saved.toString() !== "") setParams(saved, { replace: true });
  }, [settings, params, setParams]);

  /**
   * The last view actually written, so typing does not flood the sync.
   *
   * Every keystroke in the search box calls setFilters, but search is
   * not persisted — so each one would post an identical patch. Skipping
   * writes that change nothing solves that at source.
   *
   * Deliberately not a debounce, which was the first attempt: a timer
   * has to be cancelled on unmount, and cancelling it drops the save
   * when someone changes a filter and immediately opens a gig — the
   * exact moment the setting was worth keeping.
   */
  const lastWritten = useRef<string | null>(null);

  function setFilters(next: Filters) {
    setParams(toSearchParams(next), { replace: true });
    // Every field, not only the changed one: a cleared filter has to
    // persist as cleared rather than leave the old value behind.
    const patch = settingsPatchFromFilters(next);
    const fingerprint = JSON.stringify(patch);
    if (fingerprint === lastWritten.current) return;
    lastWritten.current = fingerprint;
    update(patch);
  }

  const all = gigs.data ?? [];
  const visible = applyGigFilters(all, filters, clientName, Date.now());

  // "…" while the clients are still loading. "No client" is a claim,
  // and for a gig that has one it is the wrong claim.
  const nameOf = (clientId: string | null): string | null =>
    clientId === null
      ? null
      : (clientName.get(clientId) ?? (clients.isPending ? "…" : null));

  return (
    <>
      <AppHeader title="Gigs" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {gigs.isPending && <ListSkeleton />}
        {gigs.isError && (
          <p className="text-sm text-red-600">Couldn't load gigs — pull to retry.</p>
        )}
        {all.length > 0 && (
          <GigFilters
            filters={filters}
            onChange={setFilters}
            clients={clients.data ?? []}
            shown={visible.length}
            total={all.length}
          />
        )}
        {/* `gigs.data?.length === 0`, never `all.length === 0`. The
            difference is the whole point of the test id below: `all`
            falls back to `[]` while the query is pending and again when
            it has errored, so an empty `all` is three different screens
            — nothing here yet, not loaded yet, and didn't load. Only
            this condition is the first one, which is what makes
            `gigs-empty` mean "the app is SAYING there are no gigs"
            rather than "the app has not said otherwise". Two help
            scenarios branch on exactly that; before the id existed they
            inferred it from the ABSENCE of `gig-filters` and told
            people with hundreds of gigs they had none, for as long as
            the first sync took. See help/targets.ts's `GigsEmpty`. */}
        {gigs.data?.length === 0 && (
          <EmptyState
            testId="gigs-empty"
            title="No gigs yet"
            hint="Capture your first lead — tastings, promo shifts, ambassador work."
            cta="Add a gig"
            to="/gigs/new"
          />
        )}
        {all.length > 0 && visible.length === 0 && (
          // Deliberately no "Add a gig": the gigs exist, the filter is
          // what hid them, so the useful action is widening it.
          <EmptyState
            title="No gigs match these filters"
            hint="Try a wider date range, or clear the filters."
          />
        )}
        {/* Only mounted when something is actually listed. That is what
            makes `gig-list` usable as a help branch condition: it means
            "there is a gig here to open", not merely "the gig screen
            rendered" — an always-present empty wrapper would resolve
            while the user is looking at an empty state. `space-y-3`
            moves onto the wrapper so the rows keep the spacing <main>
            was giving them. */}
        {visible.length > 0 && (
          <div className="space-y-3" data-testid="gig-list">
            {visible.map((gig) => {
              // What was paid if anything was, otherwise what the gig
              // is expected to earn. Not `amountOfferedCents`: on an
              // hourly gig that is only an optional override, so the
              // row showed no amount at all for a rated shift.
              const money = gig.amountPaidCents ?? storedOrDerivedExpectedCents(gig);
              const name = nameOf(gig.clientId);
              const heading = gigDisplayTitle(gig, name);
              // The client only repeats below when it is not already the
              // heading — losing it entirely would be worse than repeating.
              const sub = [
                name !== null && name !== heading ? name : null,
                dateLine(gig.dateTime),
                gig.location,
              ].filter((part): part is string => part !== null);
              return (
                <CardLink key={gig.id} to={`/gigs/${gig.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    {pending.data?.has(gig.id) === true && (
                      <span
                        data-testid="gig-unsynced"
                        // Not colour alone. role="img" is what makes the
                        // label legal: ARIA forbids naming a bare span
                        // (role generic), so without it the label is
                        // dropped from the accessibility tree and the
                        // marker really is colour-only.
                        role="img"
                        title="Not synced yet"
                        aria-label="Not synced yet"
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {heading}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">{sub.join(" · ")}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {/* Paid-ness is derived from the money, not the
                          status (lib/gig-pay.ts) — a confirmed gig paid
                          in full up front has nowhere else in this row
                          to say so, since `money` above shows the
                          figure but not whether it is settled. */}
                      <StatusPill status={gig.status} paid={isPaid(gig)} />
                      {money !== null && (
                        <span className="text-sm font-semibold text-slate-800">
                          {formatMoney(money)}
                        </span>
                      )}
                    </div>
                  </div>
                </CardLink>
              );
            })}
          </div>
        )}
      </main>
      <Fab to="/gigs/new" label="Add gig" testId="gig-add" />
    </>
  );
}
