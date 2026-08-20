/**
 * One gig, as two halves that change on different rhythms.
 *
 * `/gigs/:id` used to be the edit form. It is now a hub: the JOB — who
 * it is for, when, where, how it pays — read-only with an Edit button
 * onto `/gigs/:id/edit`, and the WORK — status, stamps, breaks, what it
 * earned — editable in place and saved as you touch it. The services
 * and payments sections and the delete button moved here from the form,
 * because all three are about a gig that exists, and the form now also
 * serves `/gigs/new`, where none of them can act on anything.
 *
 * This screen owns the mutation for both cards. `putGig` REPLACES the
 * record (lib/gig-input.ts), so a work-card patch is merged over the
 * whole gig here rather than in each control.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { useData } from "../lib/app-context.tsx";
import { appLog } from "../lib/logger.ts";
import { formatMoney } from "../lib/format.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import { commitGigPatch } from "../lib/gig-write.ts";
import { isPaid } from "../lib/gig-pay.ts";
import type { GigInput } from "../lib/types.ts";
import { JobCard } from "./gigs/JobCard.tsx";
import { WorkCard } from "./gigs/WorkCard.tsx";
import {
  AppHeader,
  Button,
  CardLink,
  SectionHeading,
  StatusPill,
} from "../components/index.ts";

export function GigDetail() {
  const { id = "" } = useParams();
  const api = useData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const gig = useQuery({ queryKey: ["gig", id], queryFn: () => api.getGig(id) });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });
  const services = useQuery({
    queryKey: ["services", id],
    queryFn: () => api.listServicesByGig(id),
  });
  const payments = useQuery({
    queryKey: ["payments", id],
    queryFn: () => api.listPaymentsByGig(id),
  });

  /**
   * Write one field, without disturbing the rest of the gig.
   *
   * `commitGigPatch` reads the merge base from the local store itself
   * and takes none from here — deliberately, so that `gig.data` cannot
   * be handed to it. See lib/gig-write.ts for what merging onto the
   * query cache did to the plan.
   *
   * Returns the moment the write landed, which is what the work card
   * shows in place of a Save button.
   */
  const commitPatch = useCallback(
    async (patch: GigInput): Promise<number> => {
      await commitGigPatch(api, id, patch);
      // Both keys, for the same reason the form invalidates both: the
      // list and this gig's own cache entry are separate, and leaving
      // ["gig", id] stale served the pre-edit copy for its 30s window.
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      await queryClient.invalidateQueries({ queryKey: ["gig", id] });
      return Date.now();
    },
    [api, id, queryClient],
  );

  const save = useMutation({ mutationFn: commitPatch });

  const remove = useMutation({
    mutationFn: () => api.deleteGig(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      navigate("/gigs");
    },
  });

  const data = gig.data;
  const clientName =
    data?.clientId == null
      ? null
      : (clients.data?.find((c) => c.id === data.clientId)?.name ??
        (clients.isPending ? "…" : null));

  return (
    <>
      <AppHeader title="Gig" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {gig.isPending && <p className="text-sm text-slate-500">Loading…</p>}
        {gig.isError && (
          <p className="text-sm text-red-600">
            Couldn't open this gig — it may have been deleted.
          </p>
        )}
        {data !== undefined && (
          <>
            {/* The gig's identity line: what it is called, and where it
                stands. The status PILL lives here rather than beside
                the select that sets it, because it carries something
                the select cannot — `paid`, which is derived from the
                money (lib/gig-pay.ts) and is nobody's control. One
                place to look for "where is this gig at", above both
                cards, reading the same way it reads in the list. */}
            <div className="flex items-start justify-between gap-3">
              <h2
                className="min-w-0 text-lg font-semibold text-slate-900"
                data-testid="gig-heading"
              >
                {gigDisplayTitle(data, clientName)}
              </h2>
              <span className="shrink-0 pt-1">
                <StatusPill status={data.status} paid={isPaid(data)} />
              </span>
            </div>

            <JobCard gig={data} clientName={clientName} />

            <WorkCard
              gig={data}
              onCommit={(patch) => save.mutate(patch)}
              // Deliberately NOT `save.mutate`: this fires while the
              // card is unmounting, when there is nothing left to
              // render a result into. `commitPatch` closes over the
              // data service and the query client, both of which live
              // at the app root, so the write outlives the screen. A
              // failure here has no UI to reach — the log is the whole
              // report.
              onFlush={(patch) => {
                void commitPatch(patch).catch((error: unknown) => {
                  appLog.warn("work-card flush failed", {
                    gigId: id,
                    error: String(error),
                  });
                });
              }}
              saving={save.isPending}
              failed={save.isError}
              savedAt={save.data ?? null}
            />

            {/* ── Additional services (addable at any time) ──
                Moved here from the form when the gig screen split: both
                sections act on a gig id, and the form now also serves
                `/gigs/new`, where there is no id to act on. */}
            <section className="pt-2" data-testid="gig-services">
              <SectionHeading
                actionLabel="+ Add service"
                actionTo={`/services/new?gigId=${id}`}
                actionTestId="gig-add-service"
              >
                Additional services
              </SectionHeading>
              {/* The explanation replaces "None yet." rather than
                  sitting above the list, and that is not a layout
                  preference. On the old form this paragraph rendered
                  only in the `isNew` branch, where no list existed; put
                  above a real list it becomes a second thing on the
                  screen saying "an overtime hour" — and `getByText` in
                  e2e/signed-in.spec.ts then matches both it and the
                  service row, which is a strict-mode failure. Worse, it
                  matched the paragraph BEFORE the query resolved, so
                  the assertion passed while proving nothing. Shown only
                  when there is nothing to look at, it can never collide
                  with a row, and it still teaches the feature to
                  someone whose first gig has no services yet. */}
              {services.data?.length === 0 && (
                <p className="text-xs text-slate-500">
                  Nothing yet. Extra work billed on top of the fee goes here — an
                  overtime hour, a second booth — each with its own offered and paid
                  amounts, so what a gig really earned stays right.
                </p>
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
                      <span
                        className={svc.isCompleted ? "text-slate-900" : "text-slate-600"}
                      >
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
                actionTestId="gig-add-payment"
              >
                Payments
              </SectionHeading>
              {/* Same rule as the services section above: the
                  explanation stands in for the empty state, so it can
                  never double up with a row that is already on screen. */}
              {payments.data?.length === 0 && (
                <p className="text-xs text-slate-500">
                  Nothing yet. Money as it actually lands goes here — a deposit now,
                  the balance weeks later, each with its own date and a photo of the
                  proof. Paid ($) on the job form is the running total; this is where
                  the parts of it live.
                </p>
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
          </>
        )}
      </main>
    </>
  );
}
