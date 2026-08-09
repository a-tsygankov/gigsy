import { useQuery } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { formatMoney } from "../lib/format.ts";
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

  return (
    <>
      <AppHeader title="Gigs" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {gigs.isPending && <ListSkeleton />}
        {gigs.isError && (
          <p className="text-sm text-red-600">Couldn't load gigs — pull to retry.</p>
        )}
        {gigs.data?.length === 0 && (
          <EmptyState
            title="No gigs yet"
            hint="Capture your first lead — tastings, promo shifts, ambassador work."
            cta="Add a gig"
            to="/gigs/new"
          />
        )}
        {gigs.data?.map((gig) => {
          const money =
            gig.amountPaidCents ?? gig.amountOfferedCents;
          return (
            <CardLink key={gig.id} to={`/gigs/${gig.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {gig.clientId !== null
                      ? (clientName.get(gig.clientId) ?? "…")
                      : "No client"}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {dateLine(gig.dateTime)}
                    {gig.location !== null ? ` · ${gig.location}` : ""}
                  </p>
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
