import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { GIG_STATUSES, type GigInput, type GigStatus } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { formatMoney } from "../lib/format.ts";
import {
  localInputToMs,
  msToLocalInput,
  snapToQuarterHour,
} from "../lib/datetime.ts";
import {
  AppHeader,
  Button,
  CardLink,
  Field,
  Input,
  SectionHeading,
  Select,
  Textarea,
} from "../components/index.ts";

/** Shift lengths that cover real gig work. A select rather than a time
 * picker: pickers are the slowest control on a phone, and the end time
 * is shown underneath as confirmation. */
const DURATIONS = [60, 90, 120, 180, 240, 300, 360, 480];

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
  offered: string; // dollars text
  paid: string;
  notes: string;
}

const BLANK: FormState = {
  clientId: "",
  title: "",
  status: "lead",
  dateTime: "",
  durationMinutes: "",
  location: "",
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
      status: gig.data.status,
      dateTime: msToLocalInput(gig.data.dateTime),
      durationMinutes:
        gig.data.durationMinutes !== null ? String(gig.data.durationMinutes) : "",
      location: gig.data.location ?? "",
      offered:
        gig.data.amountOfferedCents !== null
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

  // Shown under the duration select so "3h" is legible as a clock time.
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
    setMoneyError(null);
    save.mutate({
      clientId: form.clientId === "" ? null : form.clientId,
      title: form.title.trim() === "" ? null : form.title.trim(),
      status: form.status,
      dateTime: localInputToMs(form.dateTime),
      durationMinutes:
        form.durationMinutes === "" ? null : Number(form.durationMinutes),
      location: form.location.trim() === "" ? null : form.location.trim(),
      amountOfferedCents: offered,
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
              <Input
                type="datetime-local"
                data-testid="gig-datetime"
                // Quarter hours only. A gig starts at :00/:15/:30/:45,
                // not 10:07.
                //
                // `step` alone did not achieve that, which is the bug
                // this replaced: it sets the picker's granularity and
                // marks an off-grid value `stepMismatch`, but the value
                // is still whatever was typed and nothing here runs
                // native form validation before saving. So the snap
                // below is the actual rule; step only makes the
                // picker's own increments match it.
                step={900}
                value={form.dateTime}
                onChange={(e) => set("dateTime", e.target.value)}
                // On blur, not on change: change fires as each segment
                // is completed, so snapping there rewrites the minutes
                // out from under someone still typing them.
                //
                // A field nobody touches is never snapped, which is
                // deliberate — a time extracted from an email may be
                // 10:07, and quietly moving it would misreport what the
                // client actually said.
                onBlur={(e) => set("dateTime", snapToQuarterHour(e.target.value))}
              />
            </Field>

            <Field label="Duration">
              <Select
                data-testid="gig-duration"
                value={form.durationMinutes}
                onChange={(e) => set("durationMinutes", e.target.value)}
              >
                <option value="">Not set</option>
                {DURATIONS.map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </Select>
              {endsAt !== null && (
                <span className="mt-1 block text-xs text-slate-500">
                  Ends {endsAt}
                </span>
              )}
            </Field>

            <Field label="Location">
              <Input
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

            <div className="grid grid-cols-2 gap-3">
              <Field label="Offered ($)" error={moneyError}>
                <Input
                  inputMode="decimal"
                  placeholder="150.00"
                  value={form.offered}
                  onChange={(e) => set("offered", e.target.value)}
                />
              </Field>
              <Field label="Paid ($)">
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.paid}
                  onChange={(e) => set("paid", e.target.value)}
                />
              </Field>
            </div>

            <Field label="Notes">
              <Textarea
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>

            {save.isError && (
              <p className="text-sm text-red-600">Save failed — try again.</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button className="flex-1" disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Saving…" : "Save gig"}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/gigs")}>
                Cancel
              </Button>
            </div>

            {!isNew && (
              <>
                {/* ── Additional services (addable at any time) ── */}
                <section className="pt-2" data-testid="gig-services">
                  <SectionHeading
                    actionLabel="+ Add service"
                    actionTo={`/services/new?gigId=${id}`}
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
                </section>

                {/* ── Payments received for this gig ── */}
                <section className="pt-2" data-testid="gig-payments">
                  <SectionHeading
                    actionLabel="+ Add payment"
                    actionTo={`/payments/new?gigId=${id}`}
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
                </section>

                <Button
                  variant="danger"
                  block
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this gig?")) remove.mutate();
                  }}
                >
                  Delete gig
                </Button>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
