import { useQuery } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { formatMoney } from "../lib/format.ts";
import {
  AppHeader,
  CardLink,
  EmptyState,
  Fab,
  ListSkeleton,
} from "../components/index.ts";

export function Expenses() {
  const api = useData();
  const expenses = useQuery({
    queryKey: ["expenses"],
    queryFn: () => api.listExpenses(),
  });

  return (
    <>
      <AppHeader title="Expenses" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {expenses.isPending && <ListSkeleton />}
        {expenses.isError && (
          <p className="text-sm text-red-600">Couldn't load expenses.</p>
        )}
        {expenses.data?.length === 0 && (
          <EmptyState
            title="No expenses yet"
            hint="Parking, supplies, mileage — track what gigs really cost."
            cta="Add an expense"
            to="/expenses/new"
          />
        )}
        {expenses.data?.map((expense) => (
          <CardLink key={expense.id} to={`/expenses/${expense.id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  {expense.category ?? "Uncategorized"}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {new Date(expense.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-slate-800">
                {formatMoney(expense.amountCents)}
              </span>
            </div>
          </CardLink>
        ))}
      </main>
      <Fab to="/expenses/new" label="Add expense" />
    </>
  );
}
