import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import type { ClientInput } from "../lib/types.ts";
import { Header } from "../components/Header.tsx";
import { Field } from "../components/Scaffold.tsx";
import { btnDanger, btnGhost, btnPrimary, inputCls } from "../components/ui.ts";

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
            )}
          </>
        )}
      </main>
    </>
  );
}
