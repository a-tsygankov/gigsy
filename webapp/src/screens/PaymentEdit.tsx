import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { PaymentInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import { Header } from "../components/Header.tsx";
import { Field } from "../components/Scaffold.tsx";
import { btnDanger, btnGhost, btnPrimary, inputCls } from "../components/ui.ts";

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
      <Header title={isNew ? "New payment" : "Payment"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && payment.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Amount ($)" error={error}>
              <input
                inputMode="decimal"
                className={inputCls}
                placeholder="150.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>

            <Field label="Related gig">
              <select
                className={inputCls}
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
              </select>
            </Field>

            <Field label="Received on">
              <input
                type="datetime-local"
                className={inputCls}
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </Field>

            <Field label="Notes">
              <textarea
                className={`${inputCls} min-h-20`}
                placeholder="Zelle, cash, check #…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            {/* ── proof of payment ── */}
            <section data-testid="payment-confirmation">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Confirmation (photo or mail)
              </h2>
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
                    accept="image/*,.eml,.pdf"
                    className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-xl
                               file:border-0 file:bg-emerald-600 file:px-3 file:py-2
                               file:text-xs file:font-semibold file:text-white
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
              <button
                type="button"
                className={`${btnPrimary} flex-1`}
                disabled={save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Saving…" : "Save payment"}
              </button>
              <button type="button" className={btnGhost} onClick={() => navigate(backTo)}>
                {isNew ? "Cancel" : "Back"}
              </button>
            </div>
            {!isNew && (
              <>
                {gigId !== "" && (
                  <Link
                    to={`/gigs/${gigId}`}
                    className="block text-center text-xs font-medium text-emerald-700 hover:underline"
                  >
                    Open related gig →
                  </Link>
                )}
                <button
                  type="button"
                  className={`${btnDanger} w-full`}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this payment?")) remove.mutate();
                  }}
                >
                  Delete payment
                </button>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
