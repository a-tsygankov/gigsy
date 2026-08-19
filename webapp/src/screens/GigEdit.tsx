import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { GIG_STATUSES, type GigInput, type GigStatus, type PayType } from "../lib/types.ts";
import { expectedCents, workedMinutes, type PayableGig } from "../lib/gig-pay.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatMoney } from "../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import {
  AppHeader,
  Button,
  CardLink,
  DateTimeField,
  DurationField,
  Field,
  Input,
  SectionHeading,
  Select,
  Textarea,
} from "../components/index.ts";

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h > 0 ? `${h}h` : "", m > 0 ? `${m}m` : ""].filter(Boolean).join(" ");
}

interface FormState {
  clientId: string; // "" = none
  title: string;
  status: GigStatus;
  dateTime: string; // datetime-local value
  durationMinutes: string; // "" = not set
  location: string;
  payType: PayType;
  hourlyRate: string; // dollars text, hourly rate
  offered: string; // dollars text
  paid: string;
  workStart: string; // datetime-local value
  workEnd: string; // datetime-local value
  breakMinutes: string; // "" = not set
  notes: string;
}

const BLANK: FormState = {
  clientId: "",
  title: "",
  status: "lead",
  dateTime: "",
  durationMinutes: "",
  location: "",
  payType: "fixed",
  hourlyRate: "",
  offered: "",
  paid: "",
  workStart: "",
  workEnd: "",
  breakMinutes: "",
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
  const [workError, setWorkError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  useEffect(() => {
    if (gig.data === undefined) return;
    setForm({
      clientId: gig.data.clientId ?? "",
      title: gig.data.title ?? "",
      status: gig.data.status,
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
        gig.data.amountOfferedCents !== null
          ? centsToInput(gig.data.amountOfferedCents)
          : "",
      paid:
        gig.data.amountPaidCents !== null
          ? centsToInput(gig.data.amountPaidCents)
          : "",
      workStart: msToLocalInput(gig.data.workStartedAt),
      workEnd: msToLocalInput(gig.data.workEndedAt),
      breakMinutes: gig.data.breakMinutes !== null ? String(gig.data.breakMinutes) : "",
      notes: gig.data.notes ?? "",
    });
  }, [gig.data]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const services = useQuery({
    queryKey: ["services", id],
    queryFn: () => api.listServicesByGig(id),
    enabled: !isNew,
  });
  const payments = useQuery({
    queryKey: ["payments", id],
    queryFn: () => api.listPaymentsByGig(id),
    enabled: !isNew,
  });

  const save = useMutation({
    mutationFn: (input: GigInput) =>
      api.putGig(isNew ? crypto.randomUUID() : id, input),
    // The list AND this gig's own cache entry. Invalidating only the
    // list left ["gig", id] stale for its 30s window, so reopening a
    // gig you had just edited showed the values you replaced.
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      await queryClient.invalidateQueries({ queryKey: ["gig", saved.id] });
      navigate("/gigs");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteGig(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      navigate("/gigs");
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

  /** The live readout: what has been entered so far, priced. Recomputed
   *  from form state rather than from the saved record, so it answers
   *  while you are still typing. */
  const draftPay: PayableGig = {
    payType: form.payType,
    hourlyRateCents: form.hourlyRate.trim() === "" ? null : parseMoney(form.hourlyRate),
    amountOfferedCents: form.offered.trim() === "" ? null : parseMoney(form.offered),
    durationMinutes: form.durationMinutes === "" ? null : Number(form.durationMinutes),
    workStartedAt: localInputToMs(form.workStart),
    workEndedAt: localInputToMs(form.workEnd),
    breakMinutes: form.breakMinutes === "" ? null : Number(form.breakMinutes),
  };
  const worked = workedMinutes(draftPay);
  const expected = expectedCents(draftPay);
  const payLine =
    expected === null
      ? null
      : worked !== null
        ? `Worked ${formatDuration(worked)} → ${formatMoney(expected)}`
        : `Expected ${formatMoney(expected)}`;

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
    if (form.payType === "hourly" && parseMoney(form.hourlyRate) === null) {
      setMoneyError("An hourly gig needs a rate.");
      return;
    }
    setMoneyError(null);

    const workStartedAt = localInputToMs(form.workStart);
    const workEndedAt = localInputToMs(form.workEnd);
    const breakMinutes = form.breakMinutes.trim() === "" ? null : Number(form.breakMinutes);
    // Mirrors backend/src/domain/schemas.ts's superRefine, so a mistyped
    // work log fails here rather than as a 400 after "Save" — the same
    // reasoning as the hourly-rate guard above.
    if (workEndedAt !== null && workStartedAt === null) {
      setWorkError("Work can't end without a start time.");
      return;
    }
    if (workStartedAt !== null && workEndedAt !== null) {
      if (workEndedAt <= workStartedAt) {
        setWorkError("Finished must be after Started.");
        return;
      }
      if (breakMinutes !== null && breakMinutes * 60_000 >= workEndedAt - workStartedAt) {
        setWorkError("The break can't fill the whole shift.");
        return;
      }
    }
    setWorkError(null);

    save.mutate({
      clientId: form.clientId === "" ? null : form.clientId,
      title: form.title.trim() === "" ? null : form.title.trim(),
      status: form.status,
      dateTime: localInputToMs(form.dateTime),
      durationMinutes:
        form.durationMinutes === "" ? null : Number(form.durationMinutes),
      location: form.location.trim() === "" ? null : form.location.trim(),
      payType: form.payType,
      hourlyRateCents: form.payType === "hourly" ? parseMoney(form.hourlyRate) : null,
      workStartedAt,
      workEndedAt,
      breakMinutes,
      // amountOfferedCents is the fee on a fixed gig; on an hourly gig
      // it is an OVERRIDE of rate × time (lib/gig-pay.ts), and this
      // screen has no control that sets one — the Offered field above
      // is only rendered for a fixed gig. Forcing it to null here is
      // what keeps a value typed before switching to hourly from being
      // saved as an override nobody meant to set.
      amountOfferedCents: form.payType === "hourly" ? null : offered,
      amountPaidCents: paid,
      notes: form.notes.trim() === "" ? null : form.notes.trim(),
    });
  }

  return (
    <>
      <AppHeader title={isNew ? "New gig" : "Edit gig"} />
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

            <Field label="Status">
              <Select
                data-testid="gig-status"
                value={form.status}
                onChange={(e) => set("status", e.target.value as GigStatus)}
              >
                {GIG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Date & time">
              {/* Not `datetime-local`: on a phone that collapses date and
                  time into a single combined wheel, and the date half of
                  that wheel is worse than the calendar a bare date input
                  gives. Two controls also let a date be picked before the
                  hour is known — the common order a gig gets entered in. */}
              <DateTimeField
                testId="gig-datetime"
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

            <SectionHeading>Work done</SectionHeading>
            <Field label="Started">
              <DateTimeField
                testId="gig-work-start"
                value={form.workStart}
                onChange={(v) => set("workStart", v)}
              />
            </Field>
            <Field label="Finished">
              <DateTimeField
                testId="gig-work-end"
                value={form.workEnd}
                onChange={(v) => set("workEnd", v)}
              />
            </Field>
            <Field label="Off-time breaks (minutes)" error={workError}>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="w-24"
                data-testid="gig-break"
                placeholder="0"
                value={form.breakMinutes}
                onChange={(e) => set("breakMinutes", e.target.value)}
              />
            </Field>
            {payLine !== null && (
              <p className="text-sm text-slate-600" data-testid="gig-expected-pay">
                {payLine}
              </p>
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
                onClick={() => navigate("/gigs")}
              >
                Cancel
              </Button>
            </div>

            {/* ── Additional services (addable at any time) ──
                Rendered on a new gig too, explained rather than offered.
                Both live on a gig id that does not exist until the save,
                so there is nothing here to operate yet — but a form that
                simply omits them is how someone finishes their first gig
                without ever learning that the extra hour they worked has
                a place to go. Same `data-testid` in both states so one
                help target covers both.

                The explanatory state deliberately renders NO link and no
                button. `SectionHeading` drops its action entirely when
                `actionLabel`/`actionTo` are absent, which keeps
                "+ Add service" a unique accessible name on the one screen
                that has it — e2e/signed-in.spec.ts reaches the real
                control by that name, and a second match is a strict-mode
                failure, not a cosmetic one. */}
            <section className="pt-2" data-testid="gig-services">
              {isNew ? (
                <>
                  <SectionHeading>Additional services</SectionHeading>
                  <p className="text-xs text-slate-500">
                    Extra work billed on top of the fee — an overtime hour, a
                    second booth. Each one carries its own offered and paid
                    amounts, so what a gig really earned stays right. Save the
                    gig and you can add them here.
                  </p>
                </>
              ) : (
                <>
                  <SectionHeading
                    actionLabel="+ Add service"
                    actionTo={`/services/new?gigId=${id}`}
                    actionTestId="gig-add-service"
                  >
                    Additional services
                  </SectionHeading>
                  {services.data?.length === 0 && (
                    <p className="text-xs text-slate-400">None yet.</p>
                  )}
                  <div className="space-y-2">
                    {services.data?.map((svc) => (
                      <CardLink
                        key={svc.id}
                        to={`/services/${svc.id}`}
                        dense
                        className="flex items-center justify-between"
                      >
                        <span className="min-w-0 truncate">
                          <span className={svc.isCompleted ? "text-slate-900" : "text-slate-600"}>
                            {svc.isCompleted ? "✓ " : "○ "}
                            {svc.description}
                          </span>
                        </span>
                        <span className="ml-2 shrink-0 text-xs font-semibold text-slate-700">
                          {formatMoney(svc.amountPaidCents ?? 0)} /{" "}
                          {formatMoney(svc.amountOfferedCents ?? 0)}
                        </span>
                      </CardLink>
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* ── Payments received for this gig ── */}
            <section className="pt-2" data-testid="gig-payments">
              {isNew ? (
                <>
                  <SectionHeading>Payments</SectionHeading>
                  <p className="text-xs text-slate-500">
                    Money as it actually lands — a deposit now, the balance
                    weeks later, each with its own date and a photo of the
                    proof. Paid ($) above is the running total; this is where
                    the parts of it live. Save the gig and you can add them
                    here.
                  </p>
                </>
              ) : (
                <>
                  <SectionHeading
                    actionLabel="+ Add payment"
                    actionTo={`/payments/new?gigId=${id}`}
                    actionTestId="gig-add-payment"
                  >
                    Payments
                  </SectionHeading>
                  {payments.data?.length === 0 && (
                    <p className="text-xs text-slate-400">None yet.</p>
                  )}
                  <div className="space-y-2">
                    {payments.data?.map((payment) => (
                      <CardLink
                        key={payment.id}
                        to={`/payments/${payment.id}`}
                        dense
                        className="flex items-center justify-between"
                      >
                        <span className="text-slate-600">
                          {payment.paidAt !== null
                            ? new Date(payment.paidAt).toLocaleDateString()
                            : "No date"}
                          {payment.confirmationR2Key !== null && " · 📎 proof"}
                        </span>
                        <span className="shrink-0 font-semibold text-emerald-700">
                          {formatMoney(payment.amountCents)}
                        </span>
                      </CardLink>
                    ))}
                  </div>
                </>
              )}
            </section>

            {!isNew && (
              <Button
                data-testid="gig-delete"
                variant="danger"
                block
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("Delete this gig?")) remove.mutate();
                }}
              >
                Delete gig
              </Button>
            )}
          </>
        )}
      </main>
    </>
  );
}
