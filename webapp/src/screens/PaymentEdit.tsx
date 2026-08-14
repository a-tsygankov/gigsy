import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { PaymentInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import {
  AppHeader,
  Button,
  Field,
  Input,
  SectionHeading,
  Select,
  Textarea,
} from "../components/index.ts";

/** Payment entry: amount, related gig, when it was received, and the
 * photo/mail that proves it (feature spec 2026-08-08). Confirmation
 * upload is online-only. */
export function PaymentEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const [searchParams] = useSearchParams();
  const data = useData();
  const sync = useSyncState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const payment = useQuery({
    queryKey: ["payment", id],
    queryFn: () => data.getPayment(id),
    enabled: !isNew,
  });
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => data.listGigs() });

  const [amount, setAmount] = useState("");
  const [gigId, setGigId] = useState(searchParams.get("gigId") ?? "");
  const [paidAt, setPaidAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (payment.data === undefined) return;
    setAmount(centsToInput(payment.data.amountCents));
    setGigId(payment.data.gigId ?? "");
    setPaidAt(msToLocalInput(payment.data.paidAt));
    setNotes(payment.data.notes ?? "");
  }, [payment.data]);

  // Confirmation preview (authed fetch → object URL).
  useEffect(() => {
    if (isNew || payment.data?.confirmationR2Key == null) return;
    let revoked: string | null = null;
    void data.getPaymentConfirmationBlob(id).then((blob) => {
      if (blob !== null) {
        revoked = URL.createObjectURL(blob);
        setPreviewUrl(revoked);
      }
    });
    return () => {
      if (revoked !== null) URL.revokeObjectURL(revoked);
    };
  }, [isNew, id, payment.data?.confirmationR2Key, data]);

  const backTo = gigId !== "" ? `/gigs/${gigId}` : "/gigs";

  const save = useMutation({
    mutationFn: (input: PaymentInput) =>
      data.putPayment(isNew ? crypto.randomUUID() : id, input),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: ["payments"] });
      if (isNew) {
        // Stay on the saved record so a confirmation can be attached.
        navigate(`/payments/${record.id}`, { replace: true });
      } else {
        navigate(backTo);
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => data.deletePayment(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["payments"] });
      navigate(backTo);
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => data.uploadPaymentConfirmation(id, file),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["payment", id] });
    },
  });

  function submit() {
    const cents = parseMoney(amount);
    if (cents === null) {
      setError("Enter a valid dollar amount.");
      return;
    }
    if (cents <= 0) {
      setError("A payment must be greater than zero.");
      return;
    }
    setError(null);
    save.mutate({
      amountCents: cents,
      gigId: gigId === "" ? null : gigId,
      paidAt: localInputToMs(paidAt),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  }

  return (
    <>
      <AppHeader title={isNew ? "New payment" : "Payment"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && payment.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Amount ($)" error={error}>
              <Input
                data-testid="payment-amount"
                inputMode="decimal"
                placeholder="150.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>

            <Field label="Related gig">
              <Select
                data-testid="payment-gig"
                value={gigId}
                onChange={(e) => setGigId(e.target.value)}
              >
                <option value="">Not linked</option>
                {gigs.data?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {(g.location ?? "gig") +
                      (g.dateTime !== null
                        ? ` — ${new Date(g.dateTime).toLocaleDateString()}`
                        : "")}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Received on">
              <Input
                data-testid="payment-paid-at"
                type="datetime-local"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </Field>

            <Field label="Notes">
              <Textarea
                data-testid="payment-notes"
                className="min-h-20"
                placeholder="Zelle, cash, check #…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            {/* ── proof of payment ── */}
            <section data-testid="payment-confirmation">
              <SectionHeading>Confirmation (photo or mail)</SectionHeading>
              {isNew ? (
                <p className="text-xs text-slate-400">
                  Save the payment first, then attach the proof.
                </p>
              ) : (
                <>
                  {previewUrl !== null && (
                    <img
                      src={previewUrl}
                      alt="Payment confirmation"
                      className="mb-2 max-h-64 w-full rounded-xl border border-slate-200 object-contain"
                    />
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    data-testid="payment-confirmation-file"
                    accept="image/*,.eml,.pdf"
                    className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-xl
                               file:border-0 file:bg-emerald-600 file:px-3 file:py-2
                               file:text-xs file:font-semibold file:text-on-accent
                               hover:file:bg-emerald-700"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file !== undefined) upload.mutate(file);
                    }}
                  />
                  {sync !== null && !sync.online && (
                    <p className="mt-1 text-xs text-amber-700">
                      Uploads need a connection — try again when back online.
                    </p>
                  )}
                  {upload.isPending && (
                    <p className="mt-1 text-xs text-slate-500">Uploading…</p>
                  )}
                  {upload.isError && (
                    <p className="mt-1 text-xs text-red-600">Upload failed.</p>
                  )}
                </>
              )}
            </section>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                data-testid="payment-save"
                className="flex-1"
                disabled={save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Saving…" : "Save payment"}
              </Button>
              <Button
                data-testid="payment-cancel"
                variant="ghost"
                onClick={() => navigate(backTo)}
              >
                {isNew ? "Cancel" : "Back"}
              </Button>
            </div>
            {!isNew && (
              <>
                {gigId !== "" && (
                  <Link
                    to={`/gigs/${gigId}`}
                    data-testid="payment-open-gig"
                    className="block py-2 text-center text-xs font-medium text-emerald-700 hover:underline"
                  >
                    Open related gig →
                  </Link>
                )}
                <Button
                  data-testid="payment-delete"
                  variant="danger"
                  block
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this payment?")) remove.mutate();
                  }}
                >
                  Delete payment
                </Button>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
