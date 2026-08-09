import { useQuery } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import {
  AppHeader,
  CardLink,
  EmptyState,
  ListSkeleton,
} from "../components/index.ts";

export function Drafts() {
  const data = useData();
  const drafts = useQuery({
    queryKey: ["drafts", "pending"],
    queryFn: () => data.listDrafts("pending"),
  });

  return (
    <>
      <AppHeader title="Drafts" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {drafts.isPending && <ListSkeleton />}
        {drafts.isError && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Drafts need a connection.
          </p>
        )}
        {drafts.data?.length === 0 && (
          <EmptyState
            title="No drafts waiting"
            hint="Captured photos and forwarded emails land here for review."
            cta="Capture something"
            to="/capture"
          />
        )}
        {drafts.data?.map((draft) => (
          <CardLink key={draft.id} to={`/drafts/${draft.id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {draft.source === "photo" ? "📸 " : "✉️ "}
                  {draft.extracted.clientName ??
                    (draft.extracted.kind === "expense"
                      ? "Expense"
                      : "Unlabeled capture")}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {new Date(draft.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
                {draft.extracted.kind}
              </span>
            </div>
          </CardLink>
        ))}
      </main>
    </>
  );
}
