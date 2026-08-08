import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { Gig, ClientInput } from "../lib/types.ts";
import { formatMoney } from "../lib/format.ts";
import { Header } from "../components/Header.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { Field } from "../components/Scaffold.tsx";
import { btnDanger, btnGhost, btnPrimary, inputCls } from "../components/ui.ts";

/** One row in the client's job history. */
function JobRow({ gig }: { gig: Gig }) {
  return (
    <Link
      to={`/gigs/${gig.id}`}
      className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm transition-shadow hover:shadow"
    >
      <span className="min-w-0 truncate text-slate-700">
        {gig.dateTime !== null
          ? new Date(gig.dateTime).toLocaleDateString()
          : "No date"}
        {gig.location !== null ? ` · ${gig.location}` : ""}
      </span>
      <span className="ml-2 flex shrink-0 items-center gap-2">
        {(gig.amountPaidCents ?? gig.amountOfferedCents) !== null && (
          <span className="text-xs font-semibold text-slate-700">
            {formatMoney(gig.amountPaidCents ?? gig.amountOfferedCents ?? 0)}
          </span>
        )}
        <StatusPill status={gig.status} />
      </span>
    </Link>
  );
}

function JobGroup({ title, gigs }: { title: string; gigs: Gig[] }) {
  if (gigs.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-slate-500">{title}</h3>
      <div className="space-y-2">
        {gigs.map((gig) => (
          <JobRow key={gig.id} gig={gig} />
        ))}
      </div>
    </div>
  );
}

export function ClientEdit() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const api = useData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const client = useQuery({
    queryKey: ["client", id],
    queryFn: () => api.getClient(id),
    enabled: !isNew,
  });
  const gigs = useQuery({
    queryKey: ["gigs"],
    queryFn: () => api.listGigs(),
    enabled: !isNew,
  });
  const clientGigs = (gigs.data ?? []).filter((g) => g.clientId === id);

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (client.data === undefined) return;
    setName(client.data.name);
    setContact(client.data.contactInfo ?? "");
    setNotes(client.data.notes ?? "");
  }, [client.data]);

  const save = useMutation({
    mutationFn: (input: ClientInput) =>
      api.putClient(isNew ? crypto.randomUUID() : id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate("/clients");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteClient(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate("/clients");
    },
  });

  function submit() {
    if (name.trim() === "") {
      setNameError("A client needs a name.");
      return;
    }
    setNameError(null);
    save.mutate({
      name: name.trim(),
      contactInfo: contact.trim() === "" ? null : contact.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  }

  return (
    <>
      <Header title={isNew ? "New client" : "Edit client"} />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {!isNew && client.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Field label="Name" error={nameError}>
              <input
                className={inputCls}
                placeholder="Acme Staffing"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Contact">
              <input
                className={inputCls}
                placeholder="booker@acme.com · (555) 010-2233"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </Field>
            <Field label="Notes">
              <textarea
                className={`${inputCls} min-h-24`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
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
                {save.isPending ? "Saving…" : "Save client"}
              </button>
              <button
                type="button"
                className={btnGhost}
                onClick={() => navigate("/clients")}
              >
                Cancel
              </button>
            </div>
            {!isNew && (
              <>
                {/* ── all jobs for this client, grouped by state ── */}
                <section className="space-y-3 pt-2" data-testid="client-jobs">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Jobs
                  </h2>
                  {clientGigs.length === 0 && (
                    <p className="text-xs text-slate-400">No jobs yet for this client.</p>
                  )}
                  <JobGroup
                    title="Upcoming & leads"
                    gigs={clientGigs.filter((g) =>
                      ["lead", "confirmed"].includes(g.status),
                    )}
                  />
                  <JobGroup
                    title="Completed — not paid"
                    gigs={clientGigs.filter((g) => g.status === "completed")}
                  />
                  <JobGroup
                    title="Paid"
                    gigs={clientGigs.filter((g) => g.status === "paid")}
                  />
                </section>

                <button
                  type="button"
                  className={`${btnDanger} w-full`}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this client? Gigs keep their history."))
                      remove.mutate();
                  }}
                >
                  Delete client
                </button>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
