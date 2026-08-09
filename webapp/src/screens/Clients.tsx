import { useQuery } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import {
  AppHeader,
  CardLink,
  EmptyState,
  Fab,
  ListSkeleton,
} from "../components/index.ts";

export function Clients() {
  const api = useData();
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.listClients(),
  });

  return (
    <>
      <AppHeader title="Clients" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {clients.isPending && <ListSkeleton />}
        {clients.isError && (
          <p className="text-sm text-red-600">Couldn't load clients.</p>
        )}
        {clients.data?.length === 0 && (
          <EmptyState
            title="No clients yet"
            hint="Agencies and companies you work gigs for live here."
            cta="Add a client"
            to="/clients/new"
          />
        )}
        {clients.data?.map((client) => (
          <CardLink key={client.id} to={`/clients/${client.id}`}>
            <p className="text-sm font-semibold text-slate-900">{client.name}</p>
            {client.contactInfo !== null && (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {client.contactInfo}
              </p>
            )}
          </CardLink>
        ))}
      </main>
      <Fab to="/clients/new" label="Add client" />
    </>
  );
}
