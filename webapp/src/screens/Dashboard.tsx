import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useServices, useSyncState } from "../lib/app-context.tsx";
import { requestCalendarCode } from "../lib/google-signin.ts";
import { formatMoney } from "../lib/format.ts";
import {
  AppHeader,
  Button,
  ButtonLink,
  Card,
  CardLink,
  EmptyState,
  Field,
  SectionHeading,
  Select,
  Tile,
} from "../components/index.ts";

/** Google Calendar connection card (docs/plan.md §9). */
function CalendarSection() {
  const data = useData();
  const { authApi } = useServices();
  const sync = useSyncState();
  const queryClient = useQueryClient();
  const offline = sync !== null && !sync.online;
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["calendar-status"],
    queryFn: () => data.getCalendarStatus(),
    retry: false,
  });

  const connect = useMutation({
    mutationFn: async () => {
      const config = await authApi.getConfig();
      if (config.googleClientId === "") throw new Error("Google sign-in not configured.");
      const code = await requestCalendarCode(config.googleClientId);
      await data.connectCalendar(code);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendar-status"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Connect failed."),
  });

  const syncNow = useMutation({
    mutationFn: () => data.calendarSyncNow(),
    onSuccess: (r) => {
      // The server always said what it did; the UI used to discard it,
      // which made "nothing appears in my calendar" impossible to
      // diagnose from the app. Now it reports — including the silent
      // case, where the answer is usually that nothing was eligible.
      const touched = r.created + r.updated + r.deleted;
      setResult(
        touched === 0
          ? r.failed > 0
            ? failureMessage(r.failed, r.failureReason)
            : "Nothing to sync — only confirmed gigs with a date go to your calendar."
          : `Synced: ${r.created} added, ${r.updated} updated, ${r.deleted} removed.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["calendar-status"] });
    },
    onError: (e) => {
      // Say what actually went wrong. The server distinguishes a
      // revoked grant from an unreadable stored token from an
      // unreachable Google, and "try reconnecting" was useless when
      // the only cure was a disconnect the UI didn't offer.
      setError(e instanceof Error ? e.message : "Sync failed — try again.");
      void queryClient.invalidateQueries({ queryKey: ["calendar-status"] });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => data.disconnectCalendar(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendar-status"] }),
    onError: () => setError("Couldn't disconnect — try again."),
  });

  if (status.isError || status.data === undefined) return null;

  return (
    <Card as="section" data-testid="calendar-section">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">Google Calendar</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {status.data.connected
              ? `Connected ✓ — confirmed gigs sync every 15 min${
                  status.data.lastSyncAt !== null
                    ? ` · last ${new Date(status.data.lastSyncAt).toLocaleTimeString()}`
                    : ""
                }`
              : "Put confirmed gigs on your calendar automatically."}
          </p>
        </div>
        <Button
          variant="soft"
          className="shrink-0"
          disabled={offline || connect.isPending || syncNow.isPending}
          onClick={() => {
            setError(null);
            setResult(null);
            status.data?.connected ? syncNow.mutate() : connect.mutate();
          }}
        >
          {status.data.connected
            ? syncNow.isPending
              ? "Syncing…"
              : "Sync now"
            : connect.isPending
              ? "Connecting…"
              : "Connect"}
        </Button>
      </div>
      {status.data.connected && (
        <button
          type="button"
          data-testid="calendar-disconnect"
          disabled={offline || disconnect.isPending}
          onClick={() => {
            setError(null);
            if (window.confirm("Disconnect Google Calendar? Existing events stay put."))
              disconnect.mutate();
          }}
          className="mt-2 text-xs font-medium text-slate-500 hover:underline
                     disabled:opacity-50"
        >
          {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
        </button>
      )}
      {result !== null && (
        <p className="mt-2 text-xs text-slate-600" data-testid="calendar-sync-result">
          {result}
        </p>
      )}
      {error !== null && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  );
}

const DAY = 24 * 60 * 60 * 1000;

const WINDOWS = [
  { key: "30", label: "Next 30 days", days: 30 },
  { key: "90", label: "Next 90 days", days: 90 },
  { key: "365", label: "Next year", days: 365 },
  { key: "all", label: "All open", days: null },
] as const;

/** Home screen: money at a glance + drill-down into unpaid work
 * (feature spec 2026-08-08). Server-computed like reports — offline it
 * shows the last cached values or a connection note. */
/**
 * What to do about failed changes, which depends entirely on why.
 *
 * The generic "try reconnecting" was wrong for the case that actually
 * bit: the Calendar API was disabled on the Cloud project, so every
 * request 403'd while consent and the token mint reported success.
 * Reconnecting could never have fixed it, and the advice sent the user
 * round a loop.
 */
function failureMessage(failed: number, reason?: string): string {
  if (reason === "api-disabled") {
    return `Google is refusing all ${failed} change(s): the Calendar API isn't enabled for this app. That's a server-side setting — reconnecting won't help.`;
  }
  if (reason === "auth") {
    return `Google refused ${failed} change(s) — the connection has lost permission. Disconnect and reconnect in Settings.`;
  }
  return `Google rejected ${failed} change(s). It may be temporary; the next scheduled sync will retry.`;
}

export function Dashboard() {
  const data = useData();
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["key"]>("90");
  const days = WINDOWS.find((w) => w.key === windowKey)?.days ?? null;

  // Pending capture drafts (online-only; chip hides on error).
  const drafts = useQuery({
    queryKey: ["drafts", "pending"],
    queryFn: () => data.listDrafts("pending"),
    retry: false,
  });
  const pendingDrafts = drafts.data?.length ?? 0;

  const summary = useQuery({
    queryKey: ["dashboard", windowKey],
    queryFn: () =>
      data.getDashboard(
        days === null
          ? {}
          : { futureFrom: Date.now(), futureTo: Date.now() + days * DAY },
      ),
    // The tiles are server-computed while edits sync in the
    // background — poll so freshly-drained outbox changes appear
    // without a manual reload.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return (
    <>
      <AppHeader title="Dashboard" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        {/* fast capture — the product's front door */}
        <div className="flex gap-3">
          <ButtonLink to="/capture" size="lg" className="flex-1">
            📸 Capture a gig or receipt
          </ButtonLink>
          {pendingDrafts > 0 && (
            <Link
              to="/drafts"
              data-testid="drafts-chip"
              className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm
                         font-semibold text-sky-700 transition-colors hover:bg-sky-100"
            >
              {pendingDrafts} draft{pendingDrafts > 1 ? "s" : ""}
            </Link>
          )}
        </div>
        <Field label="Timeframe for expected money">
          <Select
            data-testid="dashboard-window"
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value as typeof windowKey)}
          >
            {WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>

        {summary.isError && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            The dashboard needs a connection — local data still works from
            the other tabs.
          </p>
        )}

        {summary.data !== undefined && (
          <>
            {/* Hero metric full-width (money amounts never clip on
                narrow phones), supporting tiles in halves. */}
            <div className="space-y-3">
              <Tile
                label="Unpaid — waiting on clients"
                value={formatMoney(summary.data.unpaidCents)}
                tone="warn"
                testId="tile-unpaid"
              />
              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Expected"
                  value={formatMoney(summary.data.expectedCents)}
                  tone="good"
                  testId="tile-expected"
                />
                <Tile
                  label="Completed jobs"
                  value={String(summary.data.completedCount)}
                  tone="neutral"
                  testId="tile-completed"
                />
              </div>
            </div>

            <section>
              <SectionHeading>Waiting to be paid</SectionHeading>
              {summary.data.unpaidJobs.length === 0 ? (
                <EmptyState
                  compact
                  title="Nothing outstanding — every completed job is paid."
                />
              ) : (
                <div className="space-y-3" data-testid="unpaid-jobs">
                  {summary.data.unpaidJobs.map((job) => (
                    <CardLink key={job.gigId} to={`/gigs/${job.gigId}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">
                            {job.clientName ?? "No client"}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {job.dateTime !== null
                              ? new Date(job.dateTime).toLocaleDateString()
                              : "No date"}
                            {" · gig "}
                            {formatMoney(job.paidCents)} / {formatMoney(job.offeredCents)}
                            {job.servicesOfferedCents > 0 &&
                              ` · services ${formatMoney(job.servicesPaidCents)} / ${formatMoney(job.servicesOfferedCents)}`}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-bold text-amber-700">
                          {formatMoney(job.outstandingCents)}
                        </span>
                      </div>
                    </CardLink>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <CalendarSection />
      </main>
    </>
  );
}
