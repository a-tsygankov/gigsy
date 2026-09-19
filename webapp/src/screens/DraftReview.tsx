import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { msToLocalInput, localInputToMs } from "../lib/datetime.ts";
import { collectGigDates } from "../lib/gig-dates.ts";
import { createGigBatch } from "../lib/gig-batch.ts";
import { resolveClientChoice, type ClientChoice } from "../lib/client-choice.ts";
import { matchBand, seedDraftClient } from "../lib/draft-client-match.ts";
import {
  AppHeader,
  Button,
  ClientSelect,
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
  /**
   * The gig's client, as a choice the save resolves (lib/client-
   * choice.ts) — seeded by `seedDraftClient` from the server's match:
   * the matched client when it was confident, "New client" with the
   * name the document used when nothing matched, and NOTHING while the
   * screen is still asking "is this X?" (`questionOpen`). While that
   * question is open Confirm is disabled — a guessed link is worse
   * than an extra tap (the design's confirm-gate row). Both Yes and No
   * set the choice and close the question; so does touching the select
   * by hand, because a person who picked a client has answered it.
   */
  const [client, setClient] = useState<ClientChoice>({ kind: "none" });
  const [questionOpen, setQuestionOpen] = useState(false);
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
    const seeded = seedDraftClient(extracted);
    setClient(seeded.client);
    setQuestionOpen(seeded.questionOpen);
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

  /**
   * What the banner says about the match — read at render off the
   * draft, not held in state, because it is evidence and never
   * changes: the band decides WHICH banner, and `client` (state)
   * decides whether it still applies. A confident match the person
   * then re-pointed at another client is no longer "matched", and the
   * banner goes with it.
   *
   * The matched client's name comes off the local list; the server
   * matched against the same list this device pulls (the design's "no
   * client-side re-match" row), so it is there in all but the edge of
   * a client deleted since capture, where the extracted spelling is
   * the next best thing to say.
   */
  const extracted = draft.data?.extracted;
  const band = extracted === undefined ? "none" : matchBand(extracted);
  const matchedId = extracted?.matchedClientId ?? null;
  const matchedName =
    clients.data?.find((c) => c.id === matchedId)?.name ??
    extracted?.clientName?.trim() ??
    "this client";
  const extractedName = extracted?.clientName?.trim() ?? "";
  const choseMatch = client.kind === "existing" && client.id === matchedId;

  /** Any answer — Yes, No, or a hand-picked client — closes the
   *  question. One setter for all three so none can forget the other
   *  half. */
  function answerClient(next: ClientChoice) {
    setClient(next);
    setQuestionOpen(false);
  }

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
          // The dates are checked before anything is written — a bad
          // row is refused the same way a bad amount is, thrown and
          // shown by `onError` — and only then the client: a `new`
          // choice writes a client row (lib/client-choice.ts), and a
          // row for a gig that is then refused would be an orphan.
          const dates = collectGigDates(dateTime, extraDates);
          if (!dates.ok) throw new Error(dates.message);
          const clientId = await resolveClientChoice(data, client);
          // The primary date plus the "Also on" rows: one gig per date,
          // sharing a batchId when there is more than one
          // (lib/gig-batch.ts).
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
      // A client made on the way: the gig's hub names it by that
      // client, and the Clients tab lists it — both off ["clients"].
      if (kind === "gig" && client.kind === "new") {
        await queryClient.invalidateQueries({ queryKey: ["clients"] });
      }
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

            {/* The client match, in three bands (lib/draft-client-
                match.ts). CONFIDENT: say so, and the select below is
                already on it. UNSURE: ask, with the two answers as
                buttons, and hold Confirm until one is pressed. NONE
                with a name read: say a client will be created — the
                select below is on "New client" with that name typed
                in, and the line follows what is typed. The last two
                lines share `match-banner` with the first because that
                is the one thing the capture e2e waits on: "the review
                screen is up and has read the client". */}
            {kind === "gig" && band === "confident" && choseMatch && (
              <p
                className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700"
                data-testid="match-banner"
              >
                Matched existing client: <strong>{matchedName}</strong>
                {extracted?.matchConfidence != null &&
                  ` (${Math.round(extracted.matchConfidence * 100)}%)`}
              </p>
            )}
            {kind === "gig" && questionOpen && (
              <div
                className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
                data-testid="match-question"
              >
                <p>
                  Looks like <strong>{matchedName}</strong> — is that right?
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    data-testid="draft-match-yes"
                    onClick={() => answerClient({ kind: "existing", id: matchedId! })}
                  >
                    Yes, it's {matchedName}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="draft-match-no"
                    onClick={() =>
                      answerClient(
                        extractedName === ""
                          ? { kind: "none" }
                          : { kind: "new", name: extractedName },
                      )
                    }
                  >
                    {extractedName === ""
                      ? "No, someone else"
                      : `No, new client "${extractedName}"`}
                  </Button>
                </div>
              </div>
            )}
            {kind === "gig" && client.kind === "new" && client.name.trim() !== "" && (
              <p
                className="rounded-xl bg-sky-50 p-3 text-sm text-sky-700"
                data-testid="match-banner"
              >
                New client will be created: <strong>{client.name.trim()}</strong>
              </p>
            )}

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
                  {/* The same control as the gig form's, so a client
                      the matcher missed is one tap away in the list —
                      and a hand-picked one answers the question above
                      (`answerClient`). */}
                  <ClientSelect
                    testId="draft-client"
                    label="Client"
                    clients={clients.data ?? []}
                    value={client}
                    onChange={answerClient}
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
            {kind === "gig" && questionOpen && (
              <p className="text-xs text-amber-700" data-testid="draft-match-pending">
                Answer the client question first.
              </p>
            )}
            {offline && (
              <p className="text-xs text-amber-700">
                Confirming needs a connection (the draft closes server-side).
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                className="flex-1"
                data-testid="draft-confirm"
                disabled={confirm.isPending || offline || (kind === "gig" && questionOpen)}
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
