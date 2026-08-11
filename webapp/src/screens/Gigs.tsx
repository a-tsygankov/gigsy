import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { formatMoney } from "../lib/format.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import {
  applyGigFilters,
  parseGigFilters,
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
  if (ms === null) return "No date yet";
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const pending = useQuery({
    queryKey: ["pending-gig-ids", sync?.pendingCount ?? 0],
    queryFn: () => api.pendingGigIds(),
  });

  // In the URL, not in state: a filter that evaporates the moment you
  // open a gig and come back is not worth setting in the first place.
  const [params, setParams] = useSearchParams();
  const filters = parseGigFilters(params);
  function setFilters(next: Filters) {
    setParams(toSearchParams(next), { replace: true });
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
        {gigs.data?.length === 0 && (
          <EmptyState
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
        {visible.map((gig) => {
          const money = gig.amountPaidCents ?? gig.amountOfferedCents;
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
                    // Not colour alone: the label is what a screen
                    // reader and a colour-blind user actually get.
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
                  <StatusPill status={gig.status} />
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
      </main>
      <Fab to="/gigs/new" label="Add gig" />
    </>
  );
}
