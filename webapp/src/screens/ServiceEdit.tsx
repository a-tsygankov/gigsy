import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { ServiceInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatMoney } from "../lib/format.ts";
import {
  AppHeader,
  Button,
  Field,
  Input,
  Select,
} from "../components/index.ts";

/** Add/edit an additional service on a gig — description, promised
 * payment, paid amount with an optional payment-entry link, and a
 * completion flag (feature spec 2026-08-08). */
export function ServiceEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const [searchParams] = useSearchParams();
  const data = useData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const service = useQuery({
    queryKey: ["service", id],
    queryFn: () => data.getService(id),
    enabled: !isNew,
  });
  const gigId = isNew ? (searchParams.get("gigId") ?? "") : (service.data?.gigId ?? "");

  const payments = useQuery({
    queryKey: ["payments", gigId],
    queryFn: () => data.listPaymentsByGig(gigId),
    enabled: gigId !== "",
  });

  const [description, setDescription] = useState("");
  const [offered, setOffered] = useState("");
  const [paid, setPaid] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [isCompleted, setIsCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (service.data === undefined) return;
    setDescription(service.data.description);
    setOffered(
      service.data.amountOfferedCents !== null
        ? centsToInput(service.data.amountOfferedCents)
        : "",
    );
    setPaid(
      service.data.amountPaidCents !== null
        ? centsToInput(service.data.amountPaidCents)
        : "",
    );
    setPaymentId(service.data.paymentId ?? "");
    setIsCompleted(service.data.isCompleted);
  }, [service.data]);

  const backTo = gigId !== "" ? `/gigs/${gigId}` : "/gigs";

  const save = useMutation({
    mutationFn: (input: ServiceInput) =>
      data.putService(isNew ? crypto.randomUUID() : id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] });
      navigate(backTo);
    },
  });

  const remove = useMutation({
    mutationFn: () => data.deleteService(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] });
      navigate(backTo);
    },
  });

  function submit() {
    if (gigId === "") {
      setError("A service must belong to a gig.");
      return;
    }
    if (description.trim() === "") {
      setError("Describe the service.");
      return;
    }
    const offeredCents = offered.trim() === "" ? null : parseMoney(offered);
    const paidCents = paid.trim() === "" ? null : parseMoney(paid);
    if (offeredCents === null && offered.trim() !== "") {
      setError("Offered amount isn't a valid dollar value.");
      return;
    }
    if (paidCents === null && paid.trim() !== "") {
      setError("Paid amount isn't a valid dollar value.");
      return;
    }
    if (
      (offeredCents !== null && offeredCents <= 0) ||
      (paidCents !== null && paidCents <= 0)
    ) {
      setError("Amounts must be greater than zero — leave blank when not set.");
      return;
    }
    setError(null);
    save.mutate({
      gigId,
      description: description.trim(),
      amountOfferedCents: offeredCents,
      amountPaidCents: paidCents,
      paymentId: paymentId === "" ? null : paymentId,
      isCompleted,
    });
  }

  return (
    <>
      <AppHeader title={isNew ? "New service" : "Edit service"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && service.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Description" error={error}>
              <Input
                data-testid="service-description"
                placeholder="Extra hour, banner install, teardown…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Offered ($)">
                <Input
                  data-testid="service-offered"
                  inputMode="decimal"
                  placeholder="50.00"
                  value={offered}
                  onChange={(e) => setOffered(e.target.value)}
                />
              </Field>
              <Field label="Paid ($)">
                <Input
                  data-testid="service-paid"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={paid}
                  onChange={(e) => setPaid(e.target.value)}
                />
              </Field>
            </div>

            <Field label="Payment entry">
              <Select
                data-testid="service-payment"
                value={paymentId}
                onChange={(e) => setPaymentId(e.target.value)}
              >
                <option value="">Not linked</option>
                {payments.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {formatMoney(p.amountCents)}
                    {p.paidAt !== null
                      ? ` — ${new Date(p.paidAt).toLocaleDateString()}`
                      : ""}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                data-testid="service-completed"
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                checked={isCompleted}
                onChange={(e) => setIsCompleted(e.target.checked)}
              />
              Completed
            </label>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                data-testid="service-save"
                className="flex-1"
                disabled={save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Saving…" : "Save service"}
              </Button>
              <Button
                data-testid="service-cancel"
                variant="ghost"
                onClick={() => navigate(backTo)}
              >
                Cancel
              </Button>
            </div>
            {!isNew && (
              <Button
                data-testid="service-delete"
                variant="danger"
                block
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("Delete this service?")) remove.mutate();
                }}
              >
                Delete service
              </Button>
            )}
          </>
        )}
      </main>
    </>
  );
}
