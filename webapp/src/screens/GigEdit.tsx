/**
 * What a job IS, as a form — and nothing about what happened.
 *
 * Serves two routes: `/gigs/new` (create) and `/gigs/:id/edit`. The
 * status, the work log, the expected-pay readout, the services and
 * payments lists and the delete button all moved to the detail hub
 * (GigDetail.tsx) when the gig screen split, because they are records
 * of a gig that exists rather than statements of what was agreed. What
 * is left is the agreement: who, what, when, where, and how it pays.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { GigInput, PayType } from "../lib/types.ts";
import { gigToInput } from "../lib/gig-input.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatDuration } from "../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
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
  title: string;
  dateTime: string; // "YYYY-MM-DDTHH:mm", the DateTimeField value
  durationMinutes: string; // "" = not set
  location: string;
  payType: PayType;
  hourlyRate: string; // dollars text, hourly rate
  offered: string; // dollars text
  paid: string;
  notes: string;
}

const BLANK: FormState = {
  clientId: "",
  title: "",
  dateTime: "",
  durationMinutes: "",
  location: "",
  payType: "fixed",
  hourlyRate: "",
  offered: "",
  paid: "",
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

  const [form, setForm] = useState<FormState>(BLANK);
  const [moneyError, setMoneyError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  useEffect(() => {
    if (gig.data === undefined) return;
    setForm({
      clientId: gig.data.clientId ?? "",
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
      paid:
        gig.data.amountPaidCents !== null
          ? centsToInput(gig.data.amountPaidCents)
          : "",
      notes: gig.data.notes ?? "",
    });
  }, [gig.data]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: (input: GigInput) =>
      api.putGig(isNew ? crypto.randomUUID() : id, input),
    // The list AND this gig's own cache entry. Invalidating only the
    // list left ["gig", id] stale for its 30s window, so reopening a
    // gig you had just edited showed the values you replaced.
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      await queryClient.invalidateQueries({ queryKey: ["gig", saved.id] });
      // The hub, not the list: saving a job definition is the middle of
      // a task, not the end of one — the next thing anyone does with a
      // gig is look at it or start work on it.
      navigate(`/gigs/${saved.id}`);
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
    const paid = form.paid.trim() === "" ? null : parseMoney(form.paid);
    if (offered === null && form.offered.trim() !== "") {
      setMoneyError("Offered amount isn't a valid dollar value.");
      return;
    }
    if (paid === null && form.paid.trim() !== "") {
      setMoneyError("Paid amount isn't a valid dollar value.");
      return;
    }
    if ((offered !== null && offered <= 0) || (paid !== null && paid <= 0)) {
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

    save.mutate({
      // The stored gig underneath, so this form's save carries the
      // fields it does not show — the work log and any hourly override
      // — through untouched. `putGig` REPLACES rather than patches
      // (lib/gig-input.ts), so without this base a job edit would erase
      // the shift someone recorded on the hub.
      ...(gig.data !== undefined ? gigToInput(gig.data) : {}),
      clientId: form.clientId === "" ? null : form.clientId,
      title: form.title.trim() === "" ? null : form.title.trim(),
      dateTime: localInputToMs(form.dateTime),
      durationMinutes:
        form.durationMinutes === "" ? null : Number(form.durationMinutes),
      location: form.location.trim() === "" ? null : form.location.trim(),
      payType: form.payType,
      hourlyRateCents: form.payType === "hourly" ? parseMoney(form.hourlyRate) : null,
      // amountOfferedCents is the fee on a fixed gig; on an hourly gig
      // it is an OVERRIDE of rate × time (lib/gig-pay.ts), which is the
      // work card's to set and not this form's — an override is a claim
      // about what a gig earned, not about what was agreed.
      //
      // Three cases, and the middle one is new. Fixed: the box above is
      // the fee. Still hourly: leave whatever the work card put there,
      // because `putGig` replaces and nulling it here would delete an
      // override every time somebody corrected a location. Newly
      // hourly: null, which is the original force-null — a fee typed
      // while the gig was fixed must not become an override nobody
      // meant to set. Same reason the effect above leaves `offered`
      // empty for an hourly gig: a value shown in a box this form nulls
      // on save is that trap from the other end.
      amountOfferedCents:
        form.payType !== "hourly"
          ? offered
          : gig.data?.payType === "hourly"
            ? gig.data.amountOfferedCents
            : null,
      amountPaidCents: paid,
      notes: form.notes.trim() === "" ? null : form.notes.trim(),
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

            <Field label="Paid ($)">
              <Input
                data-testid="gig-paid"
                inputMode="decimal"
                placeholder="0.00"
                value={form.paid}
                onChange={(e) => set("paid", e.target.value)}
              />
            </Field>

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
