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
import { commitGigPatch, type GigPatch } from "../lib/gig-write.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatDuration } from "../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import {
  AppHeader,
  Button,
  DateTimeField,
  DurationField,
  Field,
  Input,
  Select,
  Textarea,
} from "../components/index.ts";

interface FormState {
  clientId: string; // "" = none
  parentGigId: string; // "" = part of nothing
  title: string;
  dateTime: string; // "YYYY-MM-DDTHH:mm", the DateTimeField value
  durationMinutes: string; // "" = not set
  location: string;
  payType: PayType;
  hourlyRate: string; // dollars text, hourly rate
  offered: string; // dollars text
  notes: string;
}

const BLANK: FormState = {
  clientId: "",
  parentGigId: "",
  title: "",
  dateTime: "",
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
  const [moneyError, setMoneyError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  useEffect(() => {
    if (gig.data === undefined) return;
    setForm({
      clientId: gig.data.clientId ?? "",
      parentGigId: gig.data.parentGigId ?? "",
      title: gig.data.title ?? "",
      dateTime: msToLocalInput(gig.data.dateTime),
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
   * `form.clientId` is a string where "" means none — that is how the
   * form spells null, and `submit` below already converts it the same
   * way. Comparing the raw value against `g.clientId` would never
   * match a client-less gig, so two unattributed gigs — which ARE the
   * same client as far as the rule is concerned — would silently
   * offer each other nothing.
   *
   * Read off `form`, not off `gig.data`: change the client in the box
   * above and the list must re-filter, or the picker keeps offering
   * the old client's jobs.
   */
  const formClientId = form.clientId === "" ? null : form.clientId;
  const parentOptions = (gigs.data ?? []).filter(
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
   * disabled with a reason instead. An empty dropdown would read as
   * "nothing matches"; this is "this gig cannot be a child", which is
   * a different fact, and one the user can act on.
   */
  const hasChildren = (gigs.data ?? []).some((g) => g.parentGigId === id);

  /**
   * Change the client and a parent already picked can stop being
   * valid. Nothing on screen says so: a controlled `<select>` whose
   * value matches no option reports "" from the DOM, so the box LOOKS
   * empty while `form` still holds the old id — and the save sends it,
   * for the worker to refuse with a 400 the user cannot explain.
   *
   * Only the client can invalidate a selection from this form, so that
   * is the only mismatch checked. Two things are deliberately left
   * alone: a parent the gig list does not (yet) contain, and one that
   * gained a parent of its own elsewhere. Both are absences of local
   * knowledge, not user edits, and clearing on them would quietly
   * unlink a gig because a pull had not landed.
   */
  useEffect(() => {
    if (form.parentGigId === "" || gigs.data === undefined) return;
    const chosen = gigs.data.find((g) => g.id === form.parentGigId);
    if (chosen === undefined) return;
    if ((chosen.clientId ?? null) !== formClientId) {
      setForm((f) => ({ ...f, parentGigId: "" }));
    }
  }, [form.parentGigId, formClientId, gigs.data]);

  const save = useMutation({
    // A new gig has nothing to merge onto, so it is written whole. An
    // existing one goes through `commitGigPatch`, which reads the merge
    // base from the local store rather than from `gig.data` — the query
    // cache can be holding a pre-pull copy for 30 seconds (main.tsx's
    // staleTime), and the fields at risk here are exactly the ones this
    // form does not render: the work log. A stale base would revert the
    // shift somebody recorded on the hub, silently, on a save that was
    // only meant to fix a location. See lib/gig-write.ts.
    //
    // The cast is safe by construction: the function form of `GigPatch`
    // asks a question about the record being merged onto, and a gig
    // being created has none — so `submit` only ever passes a plain
    // object on the `isNew` path.
    mutationFn: (patch: GigPatch) =>
      isNew
        ? api.putGig(crypto.randomUUID(), patch as GigInput)
        : commitGigPatch(api, id, patch),
    // The list AND this gig's own cache entry. Invalidating only the
    // list left ["gig", id] stale for its 30s window, so reopening a
    // gig you had just edited showed the values you replaced.
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      await queryClient.invalidateQueries({ queryKey: ["gig", saved.id] });
      // The hub, not the list: saving a job definition is the middle of
      // a task, not the end of one — the next thing anyone does with a
      // gig is look at it or start work on it.
      //
      // `replace`, so Back from the hub does not return to the form
      // that has just been saved: from `/gigs/new` that form comes back
      // BLANK (a fresh create screen, with none of the gig on it),
      // which reads as the save having been thrown away.
      navigate(`/gigs/${saved.id}`, { replace: true });
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
    // from erasing them.
    const fields: GigInput = {
      clientId: form.clientId === "" ? null : form.clientId,
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
    save.mutate(
      isNew
        ? { ...fields, amountOfferedCents: form.payType === "hourly" ? null : offered }
        : (current: Gig) =>
            form.payType !== "hourly"
              ? { ...fields, amountOfferedCents: offered }
              : current.payType === "hourly"
                ? fields
                : { ...fields, amountOfferedCents: null },
    );
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

            <Field label="Client">
              <Select
                data-testid="gig-client"
                value={form.clientId}
                onChange={(e) => set("clientId", e.target.value)}
              >
                <option value="">No client</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Part of">
              <Select
                data-testid="gig-parent-select"
                disabled={hasChildren}
                value={form.parentGigId}
                onChange={(e) => set("parentGigId", e.target.value)}
              >
                <option value="">Not part of anything</option>
                {parentOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {gigDisplayTitle(
                      g,
                      g.clientId === null
                        ? null
                        : (clients.data?.find((c) => c.id === g.clientId)?.name ?? null),
                    )}
                  </option>
                ))}
              </Select>
              {hasChildren && (
                <span
                  className="mt-1 block text-xs text-slate-500"
                  data-testid="gig-parent-blocked"
                >
                  This job has follow-ups of its own, so it can&rsquo;t also be part
                  of another job. Unlink them first.
                </span>
              )}
            </Field>

            <Field label="Date & time">
              <DateTimeField
                testId="gig-datetime"
                label="Date & time"
                value={form.dateTime}
                onChange={(v) => set("dateTime", v)}
              />
            </Field>

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
