import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { Gig, PaymentInput } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatMoney } from "../lib/format.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import {
  applyAutoBalance,
  clearMismatchedRows,
  gigsForClient,
  rowsFromAllocations,
  splitWrites,
  unallocatedCents,
  unallocatedLabel,
  validateSplit,
  SPLIT_MESSAGE,
  type ParsedSplit,
  type SplitRow,
} from "../lib/payment-split.ts";
import { QUEUE_REFUSAL_MESSAGE } from "../lib/image-queue.ts";
import {
  AppHeader,
  Button,
  DateTimeField,
  Field,
  Input,
  SectionHeading,
  Select,
  SyncBadge,
  Textarea,
} from "../components/index.ts";

/**
 * One payment, and the gigs it paid for.
 *
 * A payment is money as it actually landed — one transfer, one date,
 * one photo of the proof — and an agency settling a week of work sends
 * exactly one of those for several gigs. So the single "Related gig"
 * select this screen used to carry is a LIST of splits: each row a gig
 * and an amount, saved as its own `payment_allocations` record
 * (migration 0016), which is why a half-finished split survives a
 * reload.
 *
 * The client comes first because it is what makes the rest readable:
 * name who the money came from and every gig select below narrows to
 * that client's gigs, instead of every gig ever worked. Leaving it
 * unset is allowed and offers everything — the escape hatch for a
 * transfer you cannot yet attribute.
 *
 * The remainder is allowed to be POSITIVE and is shown rather than
 * refused; the arithmetic and the rules live in lib/payment-split.ts,
 * which says why. Over-allocation is the error, and the message is the
 * server's own.
 *
 * The proof photo is CHOSEN here and uploaded later, and those are two
 * different sentences. The R2 key is server-owned and the upload
 * endpoint needs a payment id D1 recognises, so the bytes genuinely
 * cannot go anywhere until the record exists — that sequencing has not
 * changed. What changed is that it stopped being the user's problem:
 * the file input sits above Save like any other field, the file waits
 * in component state, and the save hands it to the offline photo queue
 * (lib/local-store.ts `queueImage`) which the sync engine drains. On a
 * good connection that is a second; on none it is whenever there is
 * one. Until it lands the screen says so — see the confirmation
 * section — because a payment that appears to have proof and does not
 * is worse than one that admits its photo is still waiting.
 *
 * NO `gigId` REACHES `putPayment` FROM HERE. That field is the compat
 * shim for builds that predate allocations: server-side it runs
 * `replaceSoleAllocation`, which resizes the payment's sole allocation
 * to the whole payment. A payment with one deliberately PARTIAL
 * allocation is the ordinary state of this screen and is exactly what
 * that shim would flatten (see `putPayment` in lib/local-store.ts).
 */
export function PaymentEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const [searchParams] = useSearchParams();
  const data = useData();
  const sync = useSyncState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Minted once per mount rather than inside the mutation: the
  // allocations written alongside a brand-new payment have to name it,
  // and a fresh uuid per attempt would strand them against a payment
  // that does not exist.
  const [newPaymentId] = useState(() => crypto.randomUUID());
  const paymentId = isNew ? newPaymentId : id;

  const payment = useQuery({
    queryKey: ["payment", id],
    queryFn: () => data.getPayment(id),
    enabled: !isNew,
  });
  const allocations = useQuery({
    queryKey: ["allocations", "payment", id],
    queryFn: () => data.listAllocationsByPayment(id),
    enabled: !isNew,
  });
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => data.listGigs() });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => data.listClients() });
  /**
   * Whether this payment's photo is still on the device. Keyed on
   * `paymentId`, not `id`, so it survives the replace-navigation a new
   * payment performs on save — the queue is written under the minted id
   * a moment before the URL catches up.
   *
   * `staleTime: 0` for the reason Gigs.tsx gives for its own
   * pending-ids query: this is a local read, it is cheap, and a stale
   * answer here tells the user a photo is waiting that went up thirty
   * seconds ago (or worse, the reverse).
   */
  const queuedPhoto = useQuery({
    queryKey: ["payment-photo", paymentId],
    queryFn: () => data.queuedPaymentConfirmation(paymentId),
    staleTime: 0,
  });

  const [amount, setAmount] = useState("");
  const [clientId, setClientId] = useState("");
  const [rows, setRows] = useState<SplitRow[]>(() => [
    { id: crypto.randomUUID(), gigId: searchParams.get("gigId") ?? "", amount: "" },
  ]);
  /** See `applyAutoBalance`: true until the split is touched. */
  const [autoBalance, setAutoBalance] = useState(true);
  const [paidAt, setPaidAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  /** The chosen file, held until there is a payment to attach it to. */
  const [file, setFile] = useState<File | null>(null);
  /** Set when the queue refused the file (too big, queue full). Not an
   *  error on the save, which succeeded — see `save.onSuccess`. */
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Three sources for one <img>, in the order they become true:
   * the file just chosen, the file already queued, the object the
   * server holds. Separate slots rather than one shared `previewUrl`
   * because each is filled by its own effect with its own object URL to
   * revoke, and three effects racing to write one slot is how a preview
   * ends up pointing at a URL another effect has already revoked.
   */
  const [chosenUrl, setChosenUrl] = useState<string | null>(null);
  const [queuedUrl, setQueuedUrl] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const previewUrl = chosenUrl ?? queuedUrl ?? serverUrl;

  /**
   * Seed the form from the stored record — once per record id, not
   * once per query result.
   *
   * React Query hands back a new object on every refetch, and a pull
   * lands one every time the sync engine runs. An effect that re-seeded
   * on each of those would wipe whatever was half-typed when it fired,
   * and the split editor is the screen where that costs the most.
   *
   * Both queries must have answered: seeding from a resolved payment
   * while its allocations are still pending would show an unallocated
   * payment that is nothing of the sort, and the guard below would then
   * consider the job done.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (payment.data === undefined || allocations.data === undefined) return;
    if (seededFor.current === id) return;
    seededFor.current = id;
    setAmount(centsToInput(payment.data.amountCents));
    setClientId(payment.data.clientId ?? "");
    setPaidAt(msToLocalInput(payment.data.paidAt));
    setNotes(payment.data.notes ?? "");
    const stored = rowsFromAllocations(allocations.data);
    // A payment with nothing allocated to it still gets a row to type
    // into; a blank row is dropped before anything is written.
    setRows(
      stored.length > 0
        ? stored
        : [{ id: crypto.randomUUID(), gigId: "", amount: "" }],
    );
    setAutoBalance(stored.length === 0);
  }, [id, payment.data, allocations.data]);

  /**
   * A drain changes two things this screen shows — whether the photo is
   * still queued, and whether the payment has a confirmation key yet —
   * and it writes both straight into Dexie without telling React Query
   * (lib/sync-engine.ts). The engine's pending count is the one signal
   * that does reach React, so it is what re-asks. Same pattern, and the
   * same reasoning, as the pending-gig-ids effect in Gigs.tsx.
   */
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["payment-photo", paymentId] });
    if (!isNew) {
      void queryClient.invalidateQueries({ queryKey: ["payment", id] });
    }
  }, [sync?.pendingCount, queryClient, paymentId, id, isNew]);

  // Preview of the file just chosen — immediate, and from the bytes in
  // hand rather than anything that has to be stored or fetched first.
  useEffect(() => {
    if (file === null) {
      setChosenUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setChosenUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Preview of a photo already in the queue: what the user sees on
  // re-opening a payment saved offline, where there is nothing on the
  // server to fetch.
  useEffect(() => {
    const blob = queuedPhoto.data?.blob ?? null;
    if (blob === null) {
      setQueuedUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setQueuedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [queuedPhoto.data]);

  // Confirmation preview (authed fetch → object URL).
  useEffect(() => {
    if (isNew || payment.data?.confirmationR2Key == null) return;
    let revoked: string | null = null;
    void data.getPaymentConfirmationBlob(id).then((blob) => {
      if (blob !== null) {
        revoked = URL.createObjectURL(blob);
        setServerUrl(revoked);
      }
    });
    return () => {
      if (revoked !== null) URL.revokeObjectURL(revoked);
    };
  }, [isNew, id, payment.data?.confirmationR2Key, data]);

  const allGigs = useMemo(() => gigs.data ?? [], [gigs.data]);
  const clientNameOf = (gig: Gig): string | null =>
    gig.clientId == null
      ? null
      : (clients.data?.find((c) => c.id === gig.clientId)?.name ?? null);
  const offeredGigs = useMemo(
    () => gigsForClient(allGigs, clientId),
    [allGigs, clientId],
  );

  // What the rows say right now, mirror applied. Everything below reads
  // this rather than `rows`, so what is displayed, what is summed and
  // what is saved cannot disagree.
  const shownRows = applyAutoBalance(rows, amount, autoBalance);
  const paymentCents = parseMoney(amount) ?? 0;
  const unallocated = unallocatedCents(paymentCents, shownRows);
  /**
   * The one fault worth reporting before Save is pressed.
   *
   * A row with a gig but no amount yet, or an amount mid-keystroke, is
   * a form being filled in — saying so while it happens is nagging, and
   * `submit` catches it at the moment it matters. Over-allocation is
   * different: it is a claim about the whole payment that only the
   * running total can reveal, the server will refuse it, and the sooner
   * it is said the less there is to unpick.
   */
  const liveError = unallocated < 0 ? SPLIT_MESSAGE.overAllocated : null;
  // The single gig this payment is for, when there IS one — the
  // shortcut back to it, and the screen's idea of "back".
  const soleGigId =
    shownRows.filter((row) => row.gigId !== "").length === 1
      ? (shownRows.find((row) => row.gigId !== "")?.gigId ?? "")
      : "";
  // A payment with no single gig has no gig to go back to. Before the
  // Money tab existed the gig list was the only sensible fallback;
  // now the payment came from `/payments` and belongs back there.
  const backTo = soleGigId !== "" ? `/gigs/${soleGigId}` : "/payments";

  function editRows(next: SplitRow[]): void {
    setAutoBalance(false);
    setRows(next);
    setSplitError(null);
  }

  const save = useMutation({
    // The validated splits travel WITH the payment rather than being
    // re-read from render state inside the mutation: what is written
    // must be what `submit` checked, not whatever the form holds by the
    // time the write runs.
    mutationFn: async ({
      input,
      splits,
    }: {
      input: PaymentInput;
      splits: ParsedSplit[];
    }) => {
      const record = await data.putPayment(paymentId, input);
      const writes = splitWrites(allocations.data ?? [], splits);
      // Deletes first, then upserts. A split being MOVED between gigs
      // would otherwise be over-allocated for as long as both halves
      // exist, and while the sync engine re-offers a rejected op once
      // (lib/sync-engine.ts), buying that ordering for free is better
      // than spending a round trip on it.
      for (const allocationId of writes.deletes) {
        await data.deleteAllocation(allocationId);
      }
      for (const row of writes.upserts) {
        await data.putAllocation(row.id, {
          paymentId,
          gigId: row.gigId,
          amountCents: row.amountCents,
        });
      }
      // LAST, and only now: the queue is keyed by payment id and the
      // upload endpoint needs a payment the server will recognise, so
      // the record has to exist — locally here, and server-side before
      // the drain touches it (SyncEngine.syncNow orders the two).
      //
      // A refusal is REPORTED, not thrown. The payment and its splits
      // are already on disk and correct; failing the mutation over a
      // file that was too big would show "Save failed — try again" for
      // a save that did not fail, and a second press would be a second
      // (idempotent, but pointless) write.
      const photo =
        file === null
          ? null
          : await data.queuePaymentConfirmation(paymentId, file);
      return { record, photo };
    },
    onSuccess: async ({ record, photo }) => {
      await queryClient.invalidateQueries({ queryKey: ["payments"] });
      await queryClient.invalidateQueries({ queryKey: ["allocations"] });
      await queryClient.invalidateQueries({ queryKey: ["payment", record.id] });
      await queryClient.invalidateQueries({ queryKey: ["payment-photo", paymentId] });
      if (photo !== null && !photo.queued) {
        // Stay put and say why. Navigating away from a refused photo
        // would leave the user believing the proof went with the
        // payment, which is exactly the lie this screen is built to
        // avoid — and unlike a queued photo, this one is not coming.
        setPhotoNotice(QUEUE_REFUSAL_MESSAGE[photo.refusal]);
        if (isNew) navigate(`/payments/${record.id}`, { replace: true });
        return;
      }
      setPhotoNotice(null);
      // Handed over: the queue owns the bytes now, and holding a second
      // copy in component state would keep showing the chosen-file
      // preview over the queued one it has become.
      setFile(null);
      if (fileInput.current !== null) fileInput.current.value = "";
      if (isNew) {
        // Stay on the saved record — the photo's progress is shown
        // against it, and there is nowhere else to watch that from.
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
      await queryClient.invalidateQueries({ queryKey: ["allocations"] });
      navigate(backTo);
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
    // The same check the line under the split list is already showing,
    // re-run against the parsed amount — the save is where it stops
    // being advice.
    const validated = validateSplit({
      amountCents: cents,
      clientId,
      rows: shownRows,
      gigs: allGigs,
    });
    if (validated.error !== null) {
      setSplitError(validated.error);
      return;
    }
    setSplitError(null);
    save.mutate({
      input: {
        amountCents: cents,
        clientId: clientId === "" ? null : clientId,
        paidAt: localInputToMs(paidAt),
        notes: notes.trim() === "" ? null : notes.trim(),
      },
      splits: validated.rows,
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

            {/* Asked before the gigs, because it is what makes the gig
                lists below short enough to read. Unset offers
                everything — see gigsForClient. */}
            <Field label="From client">
              <Select
                data-testid="payment-client"
                value={clientId}
                onChange={(e) => {
                  const next = e.target.value;
                  setClientId(next);
                  setRows((current) => clearMismatchedRows(current, allGigs, next));
                  setSplitError(null);
                }}
              >
                <option value="">Not set — every gig</option>
                {clients.data?.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            </Field>

            {/* ── what this payment paid for ── */}
            <section data-testid="payment-splits">
              <SectionHeading>Paid for</SectionHeading>
              <div className="space-y-2">
                {shownRows.map((row, index) => (
                  <div key={row.id} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <Select
                        data-testid={`payment-gig-${index}`}
                        aria-label={`Gig ${index + 1}`}
                        value={row.gigId}
                        onChange={(e) =>
                          editRows(
                            shownRows.map((r, i) =>
                              i === index ? { ...r, gigId: e.target.value } : r,
                            ),
                          )
                        }
                      >
                        <option value="">Choose a gig…</option>
                        {offeredGigs.map((gig) => (
                          <option key={gig.id} value={gig.id}>
                            {gigDisplayTitle(gig, clientNameOf(gig)) +
                              (gig.dateTime !== null
                                ? ` — ${new Date(gig.dateTime).toLocaleDateString()}`
                                : "")}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="w-28 shrink-0">
                      <Input
                        data-testid={`payment-split-amount-${index}`}
                        aria-label={`Amount ${index + 1}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={row.amount}
                        onChange={(e) =>
                          editRows(
                            shownRows.map((r, i) =>
                              i === index ? { ...r, amount: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    </div>
                    <Button
                      data-testid={`payment-split-remove-${index}`}
                      aria-label={`Remove split ${index + 1}`}
                      variant="ghost"
                      // The last row is emptied rather than removed —
                      // a split editor with no rows has nowhere to type
                      // the next gig.
                      onClick={() =>
                        editRows(
                          shownRows.length === 1
                            ? [{ id: crypto.randomUUID(), gigId: "", amount: "" }]
                            : shownRows.filter((_, i) => i !== index),
                        )
                      }
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                data-testid="payment-add-split"
                className="mt-2 py-1 text-xs font-semibold text-emerald-700 hover:underline"
                onClick={() =>
                  editRows([
                    ...shownRows,
                    { id: crypto.randomUUID(), gigId: "", amount: "" },
                  ])
                }
              >
                + Add gig
              </button>

              <p data-testid="payment-unallocated" className="text-sm text-slate-600">
                {unallocatedLabel(unallocated, formatMoney)}
              </p>
              {/* The over-allocation and client rules in the server's
                  own words (lib/payment-split.ts). Shown as soon as the
                  split says so, not only when Save is pressed. */}
              {(splitError ?? liveError) !== null && (
                <p data-testid="payment-split-error" className="mt-1 text-sm text-red-600">
                  {splitError ?? liveError}
                </p>
              )}
            </section>

            <Field label="Received on">
              {/* Was a bare `<input type="datetime-local">` — the app's
                  second answer to a question the gig form already
                  answered with DateTimeField. There is one now. */}
              <DateTimeField
                testId="payment-paid-at"
                label="Received on"
                value={paidAt}
                onChange={setPaidAt}
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

            {/* ── proof of payment ──
                Above the Save button and available on a brand-new
                payment, which is the entire point of Task 10: the
                moment the proof is in front of the camera is the moment
                the payment is being recorded, and a screen that says
                "save first, then attach" spends that moment. */}
            <section data-testid="payment-confirmation">
              <SectionHeading>Confirmation (photo or mail)</SectionHeading>
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
                  // Held, not sent. Nothing leaves this screen until
                  // Save, because until then there may be no payment for
                  // the bytes to belong to.
                  setFile(e.target.files?.[0] ?? null);
                  setPhotoNotice(null);
                }}
              />

              {/* Chosen but not yet saved: the one state where the
                  photo is on nobody's list — not the server's, not the
                  queue's. Saying so is cheaper than the user wondering
                  whether choosing was enough. */}
              {file !== null && !save.isPending && (
                <p data-testid="payment-photo-chosen" className="mt-1 text-xs text-slate-500">
                  Attached on save.
                </p>
              )}

              {/* Queued and still waiting. SyncBadge is the app's
                  existing way of saying "this device is holding
                  something the server has not got" — offline chip when
                  there is no link, pending count when there is one and
                  the drain has not finished. Reused rather than
                  reinvented, so the row beside the photo means exactly
                  what the same badge means in the header. */}
              {queuedPhoto.data?.blob != null && file === null && (
                <p
                  data-testid="payment-photo-pending"
                  className="mt-1 flex items-center gap-2 text-xs text-amber-700"
                >
                  {/* One, not the engine's total. The count in the
                      header is about the device; this badge is about
                      this photo, and borrowing the global figure would
                      have it read "3↑" beside a single image. */}
                  <SyncBadge online={sync?.online ?? true} pendingCount={1} />
                  Photo saved on this device — it uploads when you are back online.
                </p>
              )}

              {/* Refused for good. The row survives as a tombstone
                  precisely so this line can exist: a photo that simply
                  disappeared would leave a payment quietly claiming
                  nothing where proof was attached. */}
              {queuedPhoto.data?.failedReason != null && file === null && (
                <p data-testid="payment-photo-failed" className="mt-1 text-xs text-red-600">
                  That photo couldn’t be attached — {queuedPhoto.data.failedReason}.
                  Choose another.
                </p>
              )}

              {photoNotice !== null && (
                <p data-testid="payment-photo-refused" className="mt-1 text-xs text-red-600">
                  {photoNotice}
                </p>
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
                {soleGigId !== "" && (
                  <Link
                    to={`/gigs/${soleGigId}`}
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
