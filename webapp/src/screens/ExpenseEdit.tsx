import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { isDeliverable } from "../lib/gig-delivery.ts";
import { useSettings } from "./settings/useSettings.ts";
import type { ExpenseInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import {
  AppHeader,
  Button,
  Field,
  GigPicker,
  Input,
  Textarea,
} from "../components/index.ts";

export function ExpenseEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const api = useData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const expense = useQuery({
    queryKey: ["expense", id],
    queryFn: () => api.getExpense(id),
    enabled: !isNew,
  });
  /**
   * Every gig, for the "Linked gig" picker below — an expense may
   * belong to any of them, so there is no narrowing here (unlike the
   * parent picker on GigEdit, or the split rows on PaymentEdit). Keyed
   * ["gigs"] and ["clients"], the keys the list and the hub use, so
   * both share that cache rather than firing fetches of their own.
   * The clients are for the rows' `client · date · location` line and
   * the picker's client filter; the old `<select>` showed neither.
   */
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });
  // Only for the linked-gig picker's pills: a completed gig with
  // nothing to hand over reads as final (lib/gig-delivery.ts).
  const { settings } = useSettings();

  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [gigId, setGigId] = useState("");
  const [notes, setNotes] = useState("");
  const [reimbursable, setReimbursable] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    if (expense.data === undefined) return;
    setAmount(centsToInput(expense.data.amountCents));
    setCategory(expense.data.category ?? "");
    setGigId(expense.data.gigId ?? "");
    setNotes(expense.data.notes ?? "");
    setReimbursable(expense.data.reimbursable);
  }, [expense.data]);

  const save = useMutation({
    mutationFn: (input: ExpenseInput) =>
      api.putExpense(isNew ? crypto.randomUUID() : id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["expenses"] });
      navigate("/expenses");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteExpense(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["expenses"] });
      navigate("/expenses");
    },
  });

  function submit() {
    const cents = parseMoney(amount);
    if (cents === null) {
      setAmountError("Enter a valid dollar amount.");
      return;
    }
    if (cents <= 0) {
      setAmountError("The amount must be greater than zero.");
      return;
    }
    setAmountError(null);
    save.mutate({
      amountCents: cents,
      gigId: gigId === "" ? null : gigId,
      category: category.trim() === "" ? null : category.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
      reimbursable,
    });
  }

  return (
    <>
      <AppHeader title={isNew ? "New expense" : "Edit expense"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && expense.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Amount ($)" error={amountError}>
              <Input
                data-testid="expense-amount"
                inputMode="decimal"
                placeholder="23.50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Category">
              <Input
                data-testid="expense-category"
                placeholder="parking, supplies, mileage…"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </Field>
            <Field label="Linked gig">
              {/* Was a `<select>` with a `location — date` label of its
                  own invention, one of three formats across the app
                  (components/GigPicker.tsx's header). The picker shows
                  a gig the way the Gigs tab does and is searchable,
                  which is what "every gig" needs once there are
                  hundreds. Same test id, so the add-expense help
                  scenario keeps resolving (help/targets.ts). */}
              <GigPicker
                testId="expense-gig"
                label="Linked gig"
                placeholder="Not linked"
                gigs={gigs.data ?? []}
                clients={clients.data ?? []}
                deliverable={(g) => isDeliverable(g, clients.data ?? [], settings)}
                value={gigId}
                onChange={setGigId}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                data-testid="expense-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            {/* An expectation of reimbursement, not money received —
                reports still subtract it from net and show the
                recoverable total separately. */}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                data-testid="expense-reimbursable"
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                checked={reimbursable}
                onChange={(e) => setReimbursable(e.target.checked)}
              />
              The client should cover this
            </label>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                data-testid="expense-save"
                className="flex-1"
                disabled={save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Saving…" : "Save expense"}
              </Button>
              <Button
                data-testid="expense-cancel"
                variant="ghost"
                onClick={() => navigate("/expenses")}
              >
                Cancel
              </Button>
            </div>
            {!isNew && (
              <Button
                data-testid="expense-delete"
                variant="danger"
                block
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("Delete this expense?")) remove.mutate();
                }}
              >
                Delete expense
              </Button>
            )}
          </>
        )}
      </main>
    </>
  );
}
