import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { ExpenseInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import {
  AppHeader,
  Button,
  Field,
  Input,
  Select,
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
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });

  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [gigId, setGigId] = useState("");
  const [notes, setNotes] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    if (expense.data === undefined) return;
    setAmount(centsToInput(expense.data.amountCents));
    setCategory(expense.data.category ?? "");
    setGigId(expense.data.gigId ?? "");
    setNotes(expense.data.notes ?? "");
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

  function gigLabel(g: { location: string | null; dateTime: number | null }): string {
    const where = g.location ?? "gig";
    const when =
      g.dateTime !== null ? new Date(g.dateTime).toLocaleDateString() : "no date";
    return `${where} — ${when}`;
  }

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
                inputMode="decimal"
                placeholder="23.50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Category">
              <Input
                placeholder="parking, supplies, mileage…"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </Field>
            <Field label="Linked gig">
              <Select value={gigId} onChange={(e) => setGigId(e.target.value)}>
                <option value="">Not linked</option>
                {gigs.data?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {gigLabel(g)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button className="flex-1" disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Saving…" : "Save expense"}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/expenses")}>
                Cancel
              </Button>
            </div>
            {!isNew && (
              <Button
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
