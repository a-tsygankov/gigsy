/**
 * What a job IS, as a form — and nothing about what happened.
 *
 * Serves two routes: `/gigs/new` (create) and `/gigs/:id/edit`. The
 * status, the work log, the expected-pay readout, the services and
 * payments lists and the delete button all moved to the detail hub
 * (GigDetail.tsx) when the gig screen split, because they are records
 * of a gig that exists rather than statements of what was agreed. What
 * is left is the agreement: who, what, when, where, and how it pays.
 *
 * "Paid ($)" was the last thing on here that was neither: it stated
 * what had ARRIVED, and it went the same way when payment allocations
 * landed. `gigs.amountPaidCents` is now derived server-side from the
 * allocations against the gig (backend services/paid-totals.ts) and
 * there is no longer a write path that accepts a typed figure — so a
 * box here could only take what someone typed and drop it. The real
 * control is one screen back: GigDetail's Payments section, where each
 * payment is recorded with its own date and proof, and the running
 * total shows as the paid badge beside the status.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { Gig, GigInput, PayType } from "../lib/types.ts";
import { commitGigPatch } from "../lib/gig-write.ts";
import { collectGigDates } from "../lib/gig-dates.ts";
import { createGigBatch } from "../lib/gig-batch.ts";
import {
  NEW_CLIENT_NAME_REQUIRED,
  clientChoiceFromId,
  clientChoiceId,
  hasClientName,
  resolveClientChoice,
  type ClientChoice,
} from "../lib/client-choice.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatDuration } from "../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import {
  AppHeader,
  Button,
  ClientSelect,
  DateTimeField,
  DurationField,
  ExtraDatesField,
  Field,
  GigPicker,
  Input,
  Select,
  Textarea,
} from "../components/index.ts";

/** Why the "Part of" picker is disabled on a gig with follow-ups —
 *  rendered by the picker itself, under its trigger, as
 *  `gig-parent-select-blocked`. See `hasChildren` below. */
const PARENT_BLOCKED_REASON =
  "This job has follow-ups of its own, so it can’t also be part of another job. " +
  "Unlink them first.";

interface FormState {
  /** Who the gig is for — including a client that does not exist yet
   *  (`kind: "new"`), which is created on save and never before
   *  (lib/client-choice.ts). The select on the form is a ClientSelect,
   *  whose last option is "New client…". */
  client: ClientChoice;
  parentGigId: string; // "" = part of nothing
  title: string;
  dateTime: string; // "YYYY-MM-DDTHH:mm", the DateTimeField value
  /** The "Also on" rows, same format. One gig is created per date on
   *  save (lib/gig-batch.ts); only ever non-empty on `/gigs/new`. */
  extraDates: string[];
  durationMinutes: string; // "" = not set
  location: string;
  payType: PayType;
  hourlyRate: string; // dollars text, hourly rate
  offered: string; // dollars text
  notes: string;
}

const BLANK: FormState = {
  client: { kind: "none" },
  parentGigId: "",
  title: "",
  dateTime: "",
  extraDates: [],
  durationMinutes: "",
  location: "",
  payType: "fixed",
  hourlyRate: "",
  offered: "",
  notes: "",
};

export function GigEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const api = useData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const gig = useQuery({
    queryKey: ["gig", id],
    queryFn: () => api.getGig(id),
    enabled: !isNew,
  });
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.listClients(),
  });
  /**
   * Every gig, for the "Part of" picker below. Keyed ["gigs"] — the
   * same key the list and the hub use — so this shares that cache
   * rather than firing a fetch of its own.
   */
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });

  const [form, setForm] = useState<FormState>(BLANK);
  const [clientError, setClientError] = useState<string | null>(null);
  const [moneyError, setMoneyError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  useEffect(() => {
    if (gig.data === undefined) return;
    setForm({
      client: clientChoiceFromId(gig.data.clientId),
      parentGigId: gig.data.parentGigId ?? "",
      title: gig.data.title ?? "",
      dateTime: msToLocalInput(gig.data.dateTime),
      // Always empty on an edit: a stored gig has one date, and the
      // rows that make several are not rendered on this path (below).
      extraDates: [],
      durationMinutes:
        gig.data.durationMinutes !== null ? String(gig.data.durationMinutes) : "",
      location: gig.data.location ?? "",
      payType: gig.data.payType,
      hourlyRate:
        gig.data.hourlyRateCents !== null
          ? centsToInput(gig.data.hourlyRateCents)
          : "",
      offered:
        gig.data.amountOfferedCents !== null && gig.data.payType === "fixed"
          ? centsToInput(gig.data.amountOfferedCents)
          : "",
      notes: gig.data.notes ?? "",
    });
  }, [gig.data]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * What this gig could be part of — the client-side echo of the three
   * server rules that filter candidates (backend services/
   * gig-invariants.ts). Offering anything else would only produce a
   * save the worker refuses.
   *
   * `form.client` is a `ClientChoice`, and `clientChoiceId` reads it
   * as the rule does: an `existing` choice is its id, and both `none`
   * and `new` are null. Comparing against `g.clientId` with `?? null`
   * is what lets two unattributed gigs — which ARE the same client as
   * far as the rule is concerned — offer each other.
   *
   * A `new` client is the one case the id alone would get wrong: null
   * would read as "client-less", and offer the client-less gigs to a
   * gig that is about to carry a brand-new id the server would refuse
   * them under. A client that does not exist yet has no gigs, so its
   * list is EMPTY, and that is the honest answer rather than a gap.
   *
   * Read off `form`, not off `gig.data`: change the client in the box
   * above and the list must re-filter, or the picker keeps offering
   * the old client's jobs.
   */
  const formClientId = clientChoiceId(form.client);
  const parentOptions =
    form.client.kind === "new"
      ? []
      : (gigs.data ?? []).filter(
          (g) =>
            g.id !== id &&
            (g.clientId ?? null) === formClientId &&
            g.parentGigId === null,
        );

  /**
   * The fifth rule, and the only one that constrains the gig being
   * EDITED rather than the candidates: a gig that already has
   * follow-ups may not itself become a follow-up. Task 2's review
   * proved the other four permitted a two-level chain — accept
   * `C → B`, then accept `B → A`, and the stored tree is two deep.
   *
   * It cannot be expressed by filtering the list, so the picker is
   * disabled with a reason instead (`disabledReason`, which GigPicker
   * renders under the trigger). An empty list would read as "nothing
   * matches"; this is "this gig cannot be a child", which is a
   * different fact, and one the user can act on.
   */
  const hasChildren = (gigs.data ?? []).some((g) => g.parentGigId === id);

  /**
   * Change the client and a parent already picked can stop being
   * valid. The picker no longer hides that the way the old `<select>`
   * did (a controlled select whose value matches no option reports ""
   * from the DOM, so the box LOOKED empty while `form` still held the
   * old id) — it says "a gig this device hasn't loaded yet" — but a
   * true-sounding line under a wrong id is not much better than a
   * blank one, and the save would still send it for the worker to
   * refuse with a 400 the user cannot explain.
   *
   * Only the client can invalidate a selection from this form, so that
   * is the only mismatch checked. Two things are deliberately left
   * alone: a parent the gig list does not (yet) contain, and one that
   * gained a parent of its own elsewhere. Both are absences of local
   * knowledge, not user edits, and clearing on them would quietly
   * unlink a gig because a pull had not landed.
   *
   * A `new` client clears any parent outright: the client will have an
   * id no stored gig carries, so nothing can be its parent (the same
   * reason `parentOptions` is empty for it above). Keyed on
   * `form.client.kind` as well as `formClientId` because the id alone
   * reads null for both `none` and `new`, and switching from "No
   * client" to "New client…" must drop a client-less parent.
   */
  useEffect(() => {
    if (form.parentGigId === "" || gigs.data === undefined) return;
    if (form.client.kind === "new") {
      setForm((f) => ({ ...f, parentGigId: "" }));
      return;
    }
    const chosen = gigs.data.find((g) => g.id === form.parentGigId);
    if (chosen === undefined) return;
    if ((chosen.clientId ?? null) !== formClientId) {
      setForm((f) => ({ ...f, parentGigId: "" }));
    }
  }, [form.parentGigId, form.client.kind, formClientId, gigs.data]);

  /**
   * What `submit` hands the mutation — two shapes because the two
   * routes write differently, and a discriminated union rather than an
   * `isNew ? … : …` inside `mutationFn` so that each shape is typed
   * for its own path: a create carries the whole input plus its dates,
   * and never a patch function (which asks a question about a record
   * being merged onto, and a gig being created has none).
   *
   * Both carry the client as a CHOICE, not an id, and `input`/`patch`
   * carry no `clientId` of their own: the id is minted inside the
   * mutation (below), because a `new` choice means writing a client
   * row first, and that write belongs with the gig's — see there.
   */
  type SaveRequest = { client: ClientChoice } & (
    | { kind: "create"; input: Omit<GigInput, "clientId">; dateTimes: (number | null)[] }
    | { kind: "edit"; patch: (current: Gig) => Omit<GigInput, "clientId"> }
  );

  const save = useMutation({
    // The client first, in every case: `resolveClientChoice` (lib/
    // client-choice.ts) turns the form's choice into the id the gig is
    // written with, creating the client row when the choice is "New
    // client…". It happens INSIDE the mutation rather than in `submit`
    // so that a failed `putClient` is a failed save — same red line,
    // same button re-enabled — instead of an unhandled rejection
    // before the mutation ever started. The blank-name case never gets
    // here (`submit` refuses it under the field), but the helper
    // throws for it too, so nothing can slip past into a client called
    // "".
    //
    // Then the gig. A new gig has nothing to merge onto, so it is
    // written whole — one gig per date, through `createGigBatch`,
    // which is also what stamps the shared `batchId` when there is
    // more than one date (and null when there is one; see
    // lib/gig-batch.ts). An existing gig goes through
    // `commitGigPatch`, which reads the merge base from the local
    // store rather than from `gig.data` — the query cache can be
    // holding a pre-pull copy for 30 seconds (main.tsx's staleTime),
    // and the fields at risk here are exactly the ones this form does
    // not render: the work log. A stale base would revert the shift
    // somebody recorded on the hub, silently, on a save that was only
    // meant to fix a location. See lib/gig-write.ts.
    //
    // Both resolve to a LIST, so `onSuccess` has one shape to act on.
    mutationFn: async (request: SaveRequest): Promise<Gig[]> => {
      const clientId = await resolveClientChoice(api, request.client);
      if (request.kind === "create") {
        return createGigBatch(api, { ...request.input, clientId }, request.dateTimes);
      }
      const saved = await commitGigPatch(api, id, (current: Gig) => ({
        ...request.patch(current),
        clientId,
      }));
      return [saved];
    },
    // The list AND every saved gig's own cache entry. Invalidating only
    // the list left ["gig", id] stale for its 30s window, so reopening
    // a gig you had just edited showed the values you replaced.
    //
    // And the clients, when one was just made: the hub this navigates
    // to names the gig by its client, and the Clients tab lists them;
    // both read ["clients"], which would otherwise show the old list
    // for its stale window.
    onSuccess: async (saved, request) => {
      if (request.client.kind === "new") {
        await queryClient.invalidateQueries({ queryKey: ["clients"] });
      }
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      for (const gig of saved) {
        await queryClient.invalidateQueries({ queryKey: ["gig", gig.id] });
      }
      // ONE gig: the hub, not the list. Saving a job definition is the
      // middle of a task, not the end of one — the next thing anyone
      // does with a gig is look at it or start work on it.
      //
      // SEVERAL: the list. There is no single "the gig" to open, and
      // opening the first would hide that the rest exist; the list
      // shows all of them, newest date first (the design's "after
      // creating N > 1" row).
      //
      // `replace` either way, so Back does not return to the form that
      // has just been saved: from `/gigs/new` that form comes back
      // BLANK (a fresh create screen, with none of the gig on it),
      // which reads as the save having been thrown away.
      const only = saved.length === 1 ? saved[0] : undefined;
      navigate(only !== undefined ? `/gigs/${only.id}` : "/gigs", { replace: true });
    },
  });

  // Shown under the duration field so "3h" is legible as a clock time.
  const startMs = localInputToMs(form.dateTime);
  const endsAt =
    startMs !== null && form.durationMinutes !== ""
      ? new Date(startMs + Number(form.durationMinutes) * 60_000).toLocaleString(
          undefined,
          { weekday: "short", hour: "numeric", minute: "2-digit" },
        )
      : null;

  /** Coordinates come from the device; the worker turns them into a
   * place name. A failed lookup still fills the field with the raw
   * coordinates — better than nothing when you're in a car park. */
  async function useCurrentLocation() {
    setLocationError(null);
    if (!("geolocation" in navigator)) {
      setLocationError("This device can't share its location.");
      return;
    }
    setLocating(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
        });
      });
      const { latitude, longitude } = position.coords;
      const rough = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      try {
        const { label } = await api.reverseGeocode(latitude, longitude);
        set("location", label ?? rough);
      } catch {
        set("location", rough);
      }
    } catch {
      setLocationError("Location unavailable — check the permission and try again.");
    } finally {
      setLocating(false);
    }
  }

  function submit() {
    // The client first, because it is the first field: a "New client…"
    // with no name typed is refused here, under its own field, rather
    // than as a save error at the bottom — the box to fix is at the
    // top of the form, and the message should be beside it.
    if (!hasClientName(form.client)) {
      setClientError(NEW_CLIENT_NAME_REQUIRED);
      return;
    }
    setClientError(null);

    const offered = form.offered.trim() === "" ? null : parseMoney(form.offered);
    if (offered === null && form.offered.trim() !== "") {
      setMoneyError("Offered amount isn't a valid dollar value.");
      return;
    }
    if (offered !== null && offered <= 0) {
      setMoneyError("Amounts must be greater than zero — leave blank when not set.");
      return;
    }
    if (form.payType === "hourly") {
      const rate = parseMoney(form.hourlyRate);
      if (rate === null) {
        setMoneyError("An hourly gig needs a rate.");
        return;
      }
      if (rate <= 0) {
        setMoneyError("The hourly rate must be greater than zero.");
        return;
      }
    }
    setMoneyError(null);

    // Only what this form OWNS. Everything else — the work log, and an
    // hourly override the work card wrote — comes from the stored
    // record inside `commitGigPatch`, which is what keeps a job edit
    // from erasing them. No `clientId` here: the mutation adds it once
    // `form.client` has been resolved (a `new` choice has no id yet).
    const fields: Omit<GigInput, "clientId"> = {
      parentGigId: form.parentGigId === "" ? null : form.parentGigId,
      title: form.title.trim() === "" ? null : form.title.trim(),
      dateTime: localInputToMs(form.dateTime),
      durationMinutes:
        form.durationMinutes === "" ? null : Number(form.durationMinutes),
      location: form.location.trim() === "" ? null : form.location.trim(),
      payType: form.payType,
      hourlyRateCents: form.payType === "hourly" ? parseMoney(form.hourlyRate) : null,
      notes: form.notes.trim() === "" ? null : form.notes.trim(),
    };

    // amountOfferedCents is the fee on a fixed gig; on an hourly gig it
    // is an OVERRIDE of rate × time (lib/gig-pay.ts), which is the work
    // card's to set and not this form's — an override is a claim about
    // what a gig earned, not about what was agreed.
    //
    // Three cases. Fixed: the box above is the fee. Still hourly: the
    // key is left OUT of the patch entirely, so whatever the work card
    // wrote survives — omitting it is how `commitGigPatch` is told "not
    // mine", and setting it to the cached value would be the staleness
    // bug in miniature. Newly hourly: null, the original force-null — a
    // fee typed while the gig was fixed must not become an override
    // nobody meant to set. Same reason the effect above leaves
    // `offered` empty for an hourly gig: a value shown in a box this
    // form nulls on save is that trap from the other end.
    //
    // "Newly hourly" is judged against the STORED record, not against
    // `gig.data`, for the same reason the merge base is.
    if (isNew) {
      // The primary date plus the "Also on" rows, checked last so a
      // money problem and a date problem are not both shown at once,
      // and so the date message is the one left standing when the
      // money is fine. `fields.dateTime` is overwritten per gig by
      // `createGigBatch`; the list below is what decides how many.
      const dates = collectGigDates(form.dateTime, form.extraDates);
      if (!dates.ok) {
        setDateError(dates.message);
        return;
      }
      setDateError(null);
      save.mutate({
        kind: "create",
        client: form.client,
        input: { ...fields, amountOfferedCents: form.payType === "hourly" ? null : offered },
        dateTimes: dates.dateTimes,
      });
      return;
    }
    save.mutate({
      kind: "edit",
      client: form.client,
      patch: (current: Gig) =>
        form.payType !== "hourly"
          ? { ...fields, amountOfferedCents: offered }
          : current.payType === "hourly"
            ? fields
            : { ...fields, amountOfferedCents: null },
    });
  }

  return (
    <>
      <AppHeader title={isNew ? "New gig" : "Edit job"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && gig.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Title (optional)">
              <Input
                data-testid="gig-title"
                maxLength={200}
                placeholder="Leave empty to use the first line of notes"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
              />
            </Field>

            <Field label="Client" error={clientError}>
              {/* `gig-client` stays on the select itself (the
                  create-gig help scenario points at it: help/targets.ts's
                  GigClient). The last option is "New client…", which
                  opens a name box under it; the client is created on
                  save, not on pick — see lib/client-choice.ts. */}
              <ClientSelect
                testId="gig-client"
                label="Client"
                clients={clients.data ?? []}
                value={form.client}
                onChange={(client) => {
                  setClientError(null);
                  set("client", client);
                }}
              />
            </Field>

            <Field label="Part of">
              {/* `gig-parent-select` is kept as the id although this is
                  a picker now, not a select: the create-gig help
                  scenario points at it (help/targets.ts's
                  GigParentSelect). The candidates are `parentOptions`
                  — the picker never decides eligibility, and the four
                  rules above are this form's to echo. */}
              <GigPicker
                testId="gig-parent-select"
                label="Part of"
                placeholder="Not part of anything"
                gigs={parentOptions}
                clients={clients.data ?? []}
                value={form.parentGigId}
                onChange={(id) => set("parentGigId", id)}
                disabledReason={hasChildren ? PARENT_BLOCKED_REASON : null}
              />
            </Field>

            <Field label="Date & time">
              <DateTimeField
                testId="gig-datetime"
                label="Date & time"
                value={form.dateTime}
                onChange={(v) => set("dateTime", v)}
              />
            </Field>

            {/* New gigs only. Batches are made at creation — one form,
                N dates, N gigs sharing a batchId (lib/gig-batch.ts) —
                and an existing gig is one record with one date. Rows
                here on an edit could only mean "also create N more
                gigs like this one", which is a different action from
                saving this one and not what "Save gig" says. The
                design's table has the row: editing stays single-date.

                The date error sits under the rows rather than under
                the primary field, because "remove one" is something you
                do to a row. */}
            {isNew && (
              <div>
                <ExtraDatesField
                  testId="gig-extra-dates"
                  values={form.extraDates}
                  onChange={(v) => set("extraDates", v)}
                />
                {dateError !== null && (
                  <span
                    data-testid="gig-date-error"
                    className="mt-1 block text-xs text-red-600"
                  >
                    {dateError}
                  </span>
                )}
              </div>
            )}

            <Field label="Duration">
              <DurationField
                testId="gig-duration"
                value={form.durationMinutes}
                onChange={(v) => set("durationMinutes", v)}
              />
              {endsAt !== null && (
                <span className="mt-1 block text-xs text-slate-500">
                  {formatDuration(Number(form.durationMinutes))} · ends {endsAt}
                </span>
              )}
            </Field>

            <Field label="Location">
              <Input
                data-testid="gig-location"
                placeholder="Costco on 5th, booth 12…"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
              />
              <button
                type="button"
                data-testid="use-current-location"
                disabled={locating}
                onClick={() => void useCurrentLocation()}
                className="mt-1 text-xs font-medium text-emerald-700 hover:underline
                           disabled:opacity-50"
              >
                {locating ? "Finding you…" : "📍 Use current location"}
              </button>
              {locationError !== null && (
                <span className="mt-1 block text-xs text-amber-700">{locationError}</span>
              )}
            </Field>

            <Field label="Paid by">
              <Select
                data-testid="gig-pay-type"
                value={form.payType}
                onChange={(e) => set("payType", e.target.value as PayType)}
              >
                <option value="fixed">A fixed fee</option>
                <option value="hourly">An hourly rate</option>
              </Select>
            </Field>

            {form.payType === "hourly" ? (
              <Field label="Rate ($ per hour)" error={moneyError}>
                <Input
                  data-testid="gig-rate"
                  inputMode="decimal"
                  placeholder="50.00"
                  value={form.hourlyRate}
                  onChange={(e) => set("hourlyRate", e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Offered ($)" error={moneyError}>
                <Input
                  data-testid="gig-offered"
                  inputMode="decimal"
                  placeholder="150.00"
                  value={form.offered}
                  onChange={(e) => set("offered", e.target.value)}
                />
              </Field>
            )}

            <Field label="Notes">
              <Textarea
                data-testid="gig-notes"
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                data-testid="gig-save"
                className="flex-1"
                disabled={save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Saving…" : "Save gig"}
              </Button>
              <Button
                data-testid="gig-cancel"
                variant="ghost"
                // Back where you came from: the hub for a gig that
                // exists, the list for one that does not yet.
                onClick={() => navigate(isNew ? "/gigs" : `/gigs/${id}`)}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
