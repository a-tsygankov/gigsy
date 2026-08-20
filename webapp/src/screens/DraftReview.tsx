import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { msToLocalInput, localInputToMs } from "../lib/datetime.ts";
import {
  AppHeader,
  Button,
  DateTimeField,
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
const KIND_QUERY_KEY: Record<DraftKind, string> = {
  gig: "gigs",
  expense: "expenses",
  payment: "payments",
};

/** The review gate (docs/plan.md §8): extracted fields are editable,
 * nothing exists until Confirm. Confirming a gig or expense creates it
 * through the normal local-first path, then closes the draft
 * server-side; confirming a payment is one server round trip instead
 * (see data.confirmDraftAsPayment) because the draft's photo has to be
 * copied into the new payment's confirmation key before the draft can
 * close, and that copy needs the payment to exist on the server first —
 * a race the offline-first path can't guarantee against. */
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
    // A payment reuses dateTimeMs as its received-on date (extraction.ts).
    setDateTime(msToLocalInput(extracted.dateTimeMs ?? null));
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
      const commitHandlers: Record<DraftKind, () => Promise<{ createdId: string }>> = {
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
          const createdId = crypto.randomUUID();
          await data.putGig(createdId, {
            clientId,
            status: "lead",
            location: location.trim() === "" ? null : location.trim(),
            dateTime: localInputToMs(dateTime),
            amountOfferedCents: cents,
            notes: notes.trim() === "" ? null : notes.trim(),
            source: draft.data?.source === "email" ? "email" : "photo",
          });
          await data.setDraftStatus(id, "confirmed");
          return { createdId };
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
          return { createdId };
        },
        payment: async () => {
          if (cents === null) throw new Error("A payment needs an amount.");
          const createdId = crypto.randomUUID();
          // confirmDraftAsPayment closes the draft server-side itself
          // (it also copies the draft's photo to the payment's
          // confirmation key) — unlike gig/expense, no separate
          // setDraftStatus call follows.
          await data.confirmDraftAsPayment(id, createdId, {
            amountCents: cents,
            paidAt: localInputToMs(dateTime),
            notes: notes.trim() === "" ? null : notes.trim(),
          });
          return { createdId };
        },
      };
      return commitHandlers[kind]();
    },
    onSuccess: async ({ createdId }) => {
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      await queryClient.invalidateQueries({ queryKey: [KIND_QUERY_KEY[kind]] });
      navigate(KIND_ROUTE[kind](createdId), { replace: true });
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
