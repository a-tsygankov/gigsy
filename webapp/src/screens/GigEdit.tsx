import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServices } from "../lib/app-context.tsx";
import { GIG_STATUSES, type GigInput, type GigStatus } from "../lib/types.ts";
import { centsToInput, parseMoney } from "../lib/money.ts";
import { localInputToMs, msToLocalInput } from "../lib/datetime.ts";
import { Header } from "../components/Header.tsx";
import { Field } from "../components/Scaffold.tsx";
import { btnDanger, btnGhost, btnPrimary, inputCls } from "../components/ui.ts";

interface FormState {
  clientId: string; // "" = none
  status: GigStatus;
  dateTime: string; // datetime-local value
  location: string;
  offered: string; // dollars text
  paid: string;
  notes: string;
}

const BLANK: FormState = {
  clientId: "",
  status: "lead",
  dateTime: "",
  location: "",
  offered: "",
  paid: "",
  notes: "",
};

export function GigEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const { api } = useServices();
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
  useEffect(() => {
    if (gig.data === undefined) return;
    setForm({
      clientId: gig.data.clientId ?? "",
      status: gig.data.status,
      dateTime: msToLocalInput(gig.data.dateTime),
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

  const save = useMutation({
    mutationFn: (input: GigInput) =>
      api.putGig(isNew ? crypto.randomUUID() : id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      navigate("/");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteGig(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      navigate("/");
    },
  });

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
    setMoneyError(null);
    save.mutate({
      clientId: form.clientId === "" ? null : form.clientId,
      status: form.status,
      dateTime: localInputToMs(form.dateTime),
      location: form.location.trim() === "" ? null : form.location.trim(),
      amountOfferedCents: offered,
      amountPaidCents: paid,
      notes: form.notes.trim() === "" ? null : form.notes.trim(),
    });
  }

  return (
    <>
      <Header title={isNew ? "New gig" : "Edit gig"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && gig.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Client">
              <select
                className={inputCls}
                value={form.clientId}
                onChange={(e) => set("clientId", e.target.value)}
              >
                <option value="">No client</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Status">
              <select
                className={inputCls}
                value={form.status}
                onChange={(e) => set("status", e.target.value as GigStatus)}
              >
                {GIG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date & time">
              <input
                type="datetime-local"
                className={inputCls}
                value={form.dateTime}
                onChange={(e) => set("dateTime", e.target.value)}
              />
            </Field>

            <Field label="Location">
              <input
                className={inputCls}
                placeholder="Costco on 5th, booth 12…"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Offered ($)" error={moneyError}>
                <input
                  inputMode="decimal"
                  className={inputCls}
                  placeholder="150.00"
                  value={form.offered}
                  onChange={(e) => set("offered", e.target.value)}
                />
              </Field>
              <Field label="Paid ($)">
                <input
                  inputMode="decimal"
                  className={inputCls}
                  placeholder="0.00"
                  value={form.paid}
                  onChange={(e) => set("paid", e.target.value)}
                />
              </Field>
            </div>

            <Field label="Notes">
              <textarea
                className={`${inputCls} min-h-24`}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>

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
                {save.isPending ? "Saving…" : "Save gig"}
              </button>
              <button type="button" className={btnGhost} onClick={() => navigate("/")}>
                Cancel
              </button>
            </div>
            {!isNew && (
              <button
                type="button"
                className={`${btnDanger} w-full`}
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("Delete this gig?")) remove.mutate();
                }}
              >
                Delete gig
              </button>
            )}
          </>
        )}
      </main>
    </>
  );
}
