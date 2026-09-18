import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { msToLocalInput, localInputToMs } from "../lib/datetime.ts";
import { collectGigDates } from "../lib/gig-dates.ts";
import { createGigBatch } from "../lib/gig-batch.ts";
import {
  AppHeader,
  Button,
  DateTimeField,
  ExtraDatesField,
  Field,
  Input,
  Select,
  Textarea,
} from "../components/index.ts";

type DraftKind = "gig" | "expense" | "payment";

// What differs per kind once the fields are gathered: where the
// confirmed record lives and which list screens need refreshing. A
// third `if (kind === ...)` at every one of these decision points is
// how this file would stop being readable as kinds are added — this
// table is that decision made once. The actual commit logic (what
// fields to send, which endpoint to call) still has to be its own
// branch per kind below, since a gig, an expense and a payment don't
// share a shape; the table only covers what's genuinely uniform.
const KIND_ROUTE: Record<DraftKind, (id: string) => string> = {
  gig: (id) => `/gigs/${id}`,
  expense: (id) => `/expenses/${id}`,
  payment: (id) => `/payments/${id}`,
};
// Where to go when a confirm made MORE than one record, which only a
// gig can (a booking sheet naming several dates — lib/gig-batch.ts).
// There is no single "the record" to open then, so the list it is. The
// other two rows exist so the table stays total; nothing reaches them.
const KIND_LIST_ROUTE: Record<DraftKind, string> = {
  gig: "/gigs",
  expense: "/expenses",
  payment: "/payments",
};
const KIND_QUERY_KEY: Record<DraftKind, string> = {
  gig: "gigs",
  expense: "expenses",
  payment: "payments",
};

/** The review gate (docs/plan.md §8): extracted fields are editable,
 * nothing exists until Confirm. Confirming a gig or expense creates it
 * through the normal local-first path, then closes the draft
 * server-side; confirming a payment is one server round trip instead
 * (see data.confirmDraftAsPayment / routes/drafts.ts's confirm-payment
 * endpoint) because that route has to close the draft, create the
 * payment and copy the draft's photo into its confirmation key as one
 * atomic sequence — the offline-first path writes the record locally
 * first and lets the server catch up, which is exactly backwards here:
 * two concurrent confirms of the same draft could each see it still
 * "pending" and each create their own payment from one receipt. If the
 * server's own photo copy still comes back empty (best-effort — a
 * storage hiccup must not block the payment), this screen makes one
 * more attempt below with the blob it already has. */
export function DraftReview() {
  const { id = "" } = useParams();
  const data = useData();
  const sync = useSyncState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const offline = sync !== null && !sync.online;

  const draft = useQuery({
    queryKey: ["draft", id],
    queryFn: () => data.getDraft(id),
  });
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => data.listClients(),
  });

  const [kind, setKind] = useState<DraftKind>("gig");
  const [clientName, setClientName] = useState("");
  const [location, setLocation] = useState("");
  const [dateTime, setDateTime] = useState("");
  /** The "Also on" rows under the gig date — seeded from every date
   *  the document named beyond the first, and editable like the rest.
   *  Gig kind only; an expense or a payment is one record. */
  const [extraDates, setExtraDates] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const extracted = draft.data?.extracted;
    if (extracted === undefined) return;
    setKind(
      extracted.kind === "expense" || extracted.kind === "payment"
        ? extracted.kind
        : "gig",
    );
    setClientName(extracted.clientName ?? "");
    setLocation(extracted.location ?? "");
    // Every date the document named (extraction.ts's `dateTimesMs`), or
    // the one it named before that field existed — `dateTimeMs` is the
    // first of them either way, so an older draft and the stub read the
    // same. The first goes to the primary box and the rest become "Also
    // on" rows; a payment reuses that first one as its received-on date
    // (extraction.ts) and never sees the rows.
    const dates =
      extracted.dateTimesMs != null && extracted.dateTimesMs.length > 0
        ? extracted.dateTimesMs
        : [extracted.dateTimeMs ?? null];
    setDateTime(msToLocalInput(dates[0] ?? null));
    setExtraDates(dates.slice(1).map(msToLocalInput));
    const cents =
      extracted.kind === "expense" || extracted.kind === "payment"
        ? extracted.amountCents
        : extracted.amountOfferedCents;
    setAmount(cents != null ? centsToInput(cents) : "");
    setCategory(extracted.category ?? "");
    setNotes(extracted.notes ?? "");
  }, [draft.data]);

  useEffect(() => {
    if (draft.data?.source !== "photo" || draft.data.rawR2Key === null) return;
    let url: string | null = null;
    void data.getDraftRawBlob(id).then((blob) => {
      if (blob !== null) {
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      }
    });
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [draft.data?.source, draft.data?.rawR2Key, id, data]);

  const matchedClient = clients.data?.find(
    (c) => c.id === draft.data?.extracted.matchedClientId,
  );

  const confirm = useMutation({
    mutationFn: async () => {
      const cents = amount.trim() === "" ? null : parseMoney(amount);
      if (cents === null && amount.trim() !== "") {
        throw new Error("Amount isn't a valid dollar value.");
      }
      if (cents !== null && cents <= 0) {
        throw new Error("Amounts must be greater than zero.");
      }

      // Per-kind commit behaviour (see the KIND_ROUTE/KIND_QUERY_KEY
      // comment above for why this is a table for routing/invalidation
      // but a branch for the commit itself: the three record shapes
      // don't share fields, so there is nothing generic to hoist here).
      // `createdIds` is a list because a gig draft can name several
      // dates and confirm creates one gig per date; an expense or a
      // payment is always exactly one, and says so with a one-item list
      // rather than a second return shape for `onSuccess` to branch on.
      const commitHandlers: Record<DraftKind, () => Promise<{ createdIds: string[] }>> = {
        gig: async () => {
          // Resolve the client: matched → link it; otherwise a typed
          // name becomes a new client stub (the handoff's confirm-flow).
          let clientId = matchedClient?.id ?? null;
          if (clientId === null && clientName.trim() !== "") {
            const stub = await data.putClient(crypto.randomUUID(), {
              name: clientName.trim(),
            });
            clientId = stub.id;
          }
          // The primary date plus the "Also on" rows: one gig per date,
          // sharing a batchId when there is more than one
          // (lib/gig-batch.ts). Refused the same way a bad amount is —
          // thrown, shown by `onError` — before anything is written.
          const dates = collectGigDates(dateTime, extraDates);
          if (!dates.ok) throw new Error(dates.message);
          const created = await createGigBatch(
            data,
            {
              clientId,
              status: "lead",
              location: location.trim() === "" ? null : location.trim(),
              amountOfferedCents: cents,
              notes: notes.trim() === "" ? null : notes.trim(),
              source: draft.data?.source === "email" ? "email" : "photo",
            },
            dates.dateTimes,
          );
          // Once, after all of them: the draft is closed only when every
          // gig it named exists locally, so a failure part-way leaves it
          // pending and reviewable rather than confirmed and short.
          await data.setDraftStatus(id, "confirmed");
          return { createdIds: created.map((gig) => gig.id) };
        },
        expense: async () => {
          if (cents === null) throw new Error("An expense needs an amount.");
          const createdId = crypto.randomUUID();
          await data.putExpense(createdId, {
            amountCents: cents,
            category: category.trim() === "" ? null : category.trim(),
            notes: notes.trim() === "" ? null : notes.trim(),
          });
          await data.setDraftStatus(id, "confirmed");
          return { createdIds: [createdId] };
        },
        payment: async () => {
          if (cents === null) throw new Error("A payment needs an amount.");
          const createdId = crypto.randomUUID();
          // confirmDraftAsPayment closes the draft server-side itself
          // (it also copies the draft's photo to the payment's
          // confirmation key) — unlike gig/expense, no separate
          // setDraftStatus call follows.
          const record = await data.confirmDraftAsPayment(id, createdId, {
            amountCents: cents,
            paidAt: localInputToMs(dateTime),
            notes: notes.trim() === "" ? null : notes.trim(),
          });
          // The server's copy is best-effort (a storage hiccup must
          // not block the payment itself). When it did fail, this
          // screen is the one place left holding the photo: the draft
          // row and its rawR2Key survive confirmation even though the
          // draft is no longer "pending" (GET /api/drafts/:id/raw has
          // no status check), so re-fetch it and attach it the
          // ordinary way rather than leaving the payment with no proof
          // and the user re-picking the file from their camera roll.
          if (
            record.confirmationR2Key === null &&
            draft.data?.source === "photo" &&
            draft.data.rawR2Key !== null
          ) {
            try {
              const blob = await data.getDraftRawBlob(id);
              if (blob !== null) {
                await data.uploadPaymentConfirmation(createdId, blob);
              }
            } catch {
              // The payment itself is already real; a second failure
              // here just means the user attaches proof later from
              // PaymentEdit, the same way any payment gets one.
            }
          }
          return { createdIds: [createdId] };
        },
      };
      return commitHandlers[kind]();
    },
    onSuccess: async ({ createdIds }) => {
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      await queryClient.invalidateQueries({ queryKey: [KIND_QUERY_KEY[kind]] });
      // One record: open it. Several: the list, because there is no
      // single one to open and opening the first would hide the rest.
      const only = createdIds.length === 1 ? createdIds[0] : undefined;
      navigate(only !== undefined ? KIND_ROUTE[kind](only) : KIND_LIST_ROUTE[kind], {
        replace: true,
      });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Confirm failed."),
  });

  const discard = useMutation({
    mutationFn: () => data.setDraftStatus(id, "discarded"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      navigate("/drafts", { replace: true });
    },
  });

  const reviewed = draft.data !== undefined && draft.data.status !== "pending";

  return (
    <>
      <AppHeader title="Review draft" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {draft.isPending && <p className="text-sm text-slate-500">Loading…</p>}
        {draft.isError && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Couldn't load this draft — check your connection.
          </p>
        )}
        {reviewed && (
          <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-600">
            This draft was already {draft.data?.status}.
          </p>
        )}
        {draft.data !== undefined && !reviewed && (
          <>
            {previewUrl !== null && (
              <img
                src={previewUrl}
                alt="Captured photo"
                className="max-h-64 w-full rounded-xl border border-slate-200 object-contain"
              />
            )}
            {draft.data.source === "email" && (
              <p className="text-xs text-slate-500">✉️ Captured from a forwarded email.</p>
            )}

            {/* client match banner (gig kind) */}
            {kind === "gig" &&
              (matchedClient !== undefined ? (
                <p
                  className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700"
                  data-testid="match-banner"
                >
                  Matched existing client: <strong>{matchedClient.name}</strong>
                  {draft.data.extracted.matchConfidence != null &&
                    ` (${Math.round(draft.data.extracted.matchConfidence * 100)}%)`}
                </p>
              ) : (
                clientName.trim() !== "" && (
                  <p
                    className="rounded-xl bg-sky-50 p-3 text-sm text-sky-700"
                    data-testid="match-banner"
                  >
                    New client will be created: <strong>{clientName.trim()}</strong>
                  </p>
                )
              ))}

            <Field label="This is a…">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as DraftKind)}
              >
                <option value="gig">Gig / job offer</option>
                <option value="expense">Expense / receipt</option>
                <option value="payment">Payment received</option>
              </Select>
            </Field>

            {kind === "gig" && (
              <>
                <Field label="Client">
                  <Input
                    placeholder="Agency or company"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    disabled={matchedClient !== undefined}
                  />
                </Field>
                <Field label="Location">
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                </Field>
                <Field label="Date & time">
                  {/* The same DateTimeField the gig form uses — this
                      screen creates gigs too, and one control for a
                      moment is the whole point of it.

                      The extracted time is safe: the time input accepts
                      every minute, so 14:18 pulled from an email is never
                      silently corrected to something else. What the
                      email said is evidence, and this screen exists for
                      the user to check it. */}
                  <DateTimeField
                    testId="draft-datetime"
                    label="Date & time"
                    value={dateTime}
                    onChange={setDateTime}
                  />
                </Field>
                {/* The other dates the sheet named, one gig each on
                    Confirm — and rows the person can add or remove, since
                    what was extracted is evidence to check, not a verdict.
                    Gig kind only: an expense or a payment is one record. */}
                <ExtraDatesField
                  testId="draft-extra-dates"
                  values={extraDates}
                  onChange={setExtraDates}
                />
                <Field label="Offered ($)">
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === "expense" && (
              <>
                <Field label="Amount ($)">
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <Field label="Category">
                  <Input
                    placeholder="parking, supplies…"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === "payment" && (
              <>
                <Field label="Amount ($)">
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <Field label="Received on">
                  <DateTimeField
                    testId="draft-datetime"
                    label="Received on"
                    value={dateTime}
                    onChange={setDateTime}
                  />
                </Field>
                {/* No gig link and no client here on purpose — splitting
                    a payment across gigs is Task 7's screen, and this
                    kind doesn't set clientId (PaymentInput has no such
                    field yet on this branch; see the payment screen to
                    attach either after confirming). */}
              </>
            )}

            <Field label="Notes">
              <Textarea
                className="min-h-20"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            {error !== null && <p className="text-sm text-red-600">{error}</p>}
            {offline && (
              <p className="text-xs text-amber-700">
                Confirming needs a connection (the draft closes server-side).
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                className="flex-1"
                data-testid="draft-confirm"
                disabled={confirm.isPending || offline}
                onClick={() => {
                  setError(null);
                  confirm.mutate();
                }}
              >
                {confirm.isPending ? "Creating…" : `Confirm ${kind}`}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/drafts")}>
                Later
              </Button>
            </div>
            <Button
              variant="danger"
              block
              disabled={discard.isPending || offline}
              onClick={() => {
                if (window.confirm("Discard this draft?")) discard.mutate();
              }}
            >
              Discard draft
            </Button>
          </>
        )}
      </main>
    </>
  );
}
