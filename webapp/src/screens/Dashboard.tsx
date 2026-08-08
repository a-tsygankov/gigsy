import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useData } from "../lib/app-context.tsx";
import { formatMoney } from "../lib/format.ts";
import { Header } from "../components/Header.tsx";
import { card } from "../components/ui.ts";

const DAY = 24 * 60 * 60 * 1000;

const WINDOWS = [
  { key: "30", label: "Next 30 days", days: 30 },
  { key: "90", label: "Next 90 days", days: 90 },
  { key: "365", label: "Next year", days: 365 },
  { key: "all", label: "All open", days: null },
] as const;

function Tile({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string;
  tone: "neutral" | "good" | "warn";
  testId: string;
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p data-testid={testId} className={`mt-1 text-2xl font-bold ${toneCls}`}>
        {value}
      </p>
    </div>
  );
}

/** Home screen: money at a glance + drill-down into unpaid work
 * (feature spec 2026-08-08). Server-computed like reports — offline it
 * shows the last cached values or a connection note. */
export function Dashboard() {
  const data = useData();
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["key"]>("90");
  const days = WINDOWS.find((w) => w.key === windowKey)?.days ?? null;

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
      <Header title="Dashboard" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Timeframe for expected money
          </span>
          <select
            data-testid="dashboard-window"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value as typeof windowKey)}
          >
            {WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        </label>

        {summary.isError && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            The dashboard needs a connection — local data still works from
            the other tabs.
          </p>
        )}

        {summary.data !== undefined && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Tile
                label="Completed"
                value={String(summary.data.completedCount)}
                tone="neutral"
                testId="tile-completed"
              />
              <Tile
                label="Expected"
                value={formatMoney(summary.data.expectedCents)}
                tone="good"
                testId="tile-expected"
              />
              <Tile
                label="Unpaid"
                value={formatMoney(summary.data.unpaidCents)}
                tone="warn"
                testId="tile-unpaid"
              />
            </div>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Waiting to be paid
              </h2>
              {summary.data.unpaidJobs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white/50 p-4 text-center text-sm text-slate-500">
                  Nothing outstanding — every completed job is paid.
                </p>
              ) : (
                <div className="space-y-3" data-testid="unpaid-jobs">
                  {summary.data.unpaidJobs.map((job) => (
                    <Link key={job.gigId} to={`/gigs/${job.gigId}`} className={card}>
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
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
