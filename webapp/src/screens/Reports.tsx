import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { ReportFilters } from "../lib/types.ts";
import { formatMoney } from "../lib/format.ts";
import { toCsv, downloadCsv } from "../lib/csv.ts";
import {
  EXPENSE_HEADERS,
  INCOME_HEADERS,
  SUMMARY_HEADERS,
  expenseRows,
  incomeRows,
  monthLabel,
  summaryRows,
} from "../lib/report-export.ts";
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  ListSkeleton,
  SectionHeading,
  Select,
  Tile,
} from "../components/index.ts";

/** Preset ranges. Date pickers are the slowest control on a phone, so
 * the common tax windows are one tap; "custom" reveals the inputs. */
const RANGES = [
  { key: "ytd", label: "This year" },
  { key: "last-year", label: "Last year" },
  { key: "12m", label: "Last 12 months" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom range…" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/** Local-midnight bounds for a preset, so a range means the same thing
 * as the dates a user would read off a calendar. */
function presetBounds(key: RangeKey, now: Date): { from?: number; to?: number } {
  const year = now.getFullYear();
  switch (key) {
    case "ytd":
      return { from: new Date(year, 0, 1).getTime() };
    case "last-year":
      return {
        from: new Date(year - 1, 0, 1).getTime(),
        to: new Date(year - 1, 11, 31, 23, 59, 59, 999).getTime(),
      };
    case "12m":
      return { from: new Date(year, now.getMonth() - 11, 1).getTime() };
    default:
      return {};
  }
}

/** Date-only input value → epoch ms at the start (or end) of that day. */
function dayBound(value: string, edge: "start" | "end"): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return edge === "start"
    ? new Date(y, mo, d).getTime()
    : new Date(y, mo, d, 23, 59, 59, 999).getTime();
}

function MoneyRow({ label, sub, value, tone }: {
  label: string;
  sub: string;
  value: string;
  tone: "neutral" | "good";
}) {
  return (
    <Card dense className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-900">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{sub}</span>
      </span>
      <span
        className={`shrink-0 font-semibold tabular-nums ${
          tone === "good" ? "text-emerald-700" : "text-slate-800"
        }`}
      >
        {value}
      </span>
    </Card>
  );
}

/** Reports + CSV export (docs/plan.md §10). The summary is
 * server-computed; the exports are built from the local ledger, so
 * they work offline and honour the same filters shown above them. */
export function Reports() {
  const data = useData();
  const sync = useSyncState();
  const offline = sync !== null && !sync.online;

  const [rangeKey, setRangeKey] = useState<RangeKey>("ytd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [clientId, setClientId] = useState("");

  const clients = useQuery({ queryKey: ["clients"], queryFn: () => data.listClients() });

  const filters = useMemo<ReportFilters>(() => {
    const bounds =
      rangeKey === "custom"
        ? { from: dayBound(customFrom, "start"), to: dayBound(customTo, "end") }
        : presetBounds(rangeKey, new Date());
    return {
      ...(bounds.from !== undefined ? { from: bounds.from } : {}),
      ...(bounds.to !== undefined ? { to: bounds.to } : {}),
      ...(clientId !== "" ? { clientId } : {}),
    };
  }, [rangeKey, customFrom, customTo, clientId]);

  const summary = useQuery({
    queryKey: ["report-summary", filters],
    queryFn: () => data.getReportSummary(filters),
    retry: false,
  });

  // Exports read the local ledger — available offline, unlike the
  // server-computed summary above them.
  async function exportIncome() {
    const [gigs, services, clientList] = await Promise.all([
      data.listGigs(),
      data.listServices(),
      data.listClients(),
    ]);
    downloadCsv(
      `gigsy-income-${stamp()}.csv`,
      toCsv(INCOME_HEADERS, incomeRows(gigs, services, clientList, filters)),
    );
  }

  async function exportExpenses() {
    const [expenses, gigs, clientList] = await Promise.all([
      data.listExpenses(),
      data.listGigs(),
      data.listClients(),
    ]);
    downloadCsv(
      `gigsy-expenses-${stamp()}.csv`,
      toCsv(EXPENSE_HEADERS, expenseRows(expenses, gigs, clientList, filters)),
    );
  }

  function exportSummary() {
    if (summary.data === undefined) return;
    downloadCsv(
      `gigsy-summary-${stamp()}.csv`,
      toCsv(SUMMARY_HEADERS, summaryRows(summary.data.byMonth)),
    );
  }

  return (
    <>
      <AppHeader title="Reports" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        <Card as="section" className="space-y-3">
          <Field label="Period">
            <Select
              data-testid="report-range"
              value={rangeKey}
              onChange={(e) => setRangeKey(e.target.value as RangeKey)}
            >
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>

          {rangeKey === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input
                  type="date"
                  data-testid="report-from"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  data-testid="report-to"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </Field>
            </div>
          )}

          <Field label="Client">
            <Select
              data-testid="report-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">All clients</option>
              {clients.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        {summary.isPending && <ListSkeleton rows={3} />}

        {summary.isError && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Reports need a connection — the totals are computed on the server.
            Exports below still work from your local data.
          </p>
        )}

        {summary.data !== undefined && (
          <>
            <div className="space-y-3">
              <Tile
                label="Net — paid minus expenses"
                value={formatMoney(summary.data.totals.netCents)}
                tone="good"
                testId="tile-net"
              />
              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Paid"
                  value={formatMoney(summary.data.totals.paidCents)}
                  tone="neutral"
                  testId="tile-paid"
                />
                <Tile
                  label="Still owed"
                  value={formatMoney(summary.data.totals.varianceCents)}
                  tone="warn"
                  testId="tile-variance"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Expenses"
                  value={formatMoney(summary.data.totals.expensesCents)}
                  tone="neutral"
                  testId="tile-expenses"
                />
                <Tile
                  label="Billable to client"
                  value={formatMoney(summary.data.totals.reimbursableCents)}
                  tone="neutral"
                  testId="tile-reimbursable"
                />
              </div>
            </div>

            <section data-testid="report-months">
              <SectionHeading>By month</SectionHeading>
              {summary.data.byMonth.length === 0 ? (
                <EmptyState compact title="Nothing in this period yet." />
              ) : (
                <div className="space-y-2">
                  {summary.data.byMonth.map((m) => (
                    <MoneyRow
                      key={m.month}
                      label={monthLabel(m.month)}
                      sub={`paid ${formatMoney(m.paidCents)} · expenses ${formatMoney(m.expensesCents)}`}
                      value={formatMoney(m.netCents)}
                      tone="good"
                    />
                  ))}
                </div>
              )}
            </section>

            <section data-testid="report-clients">
              <SectionHeading>By client</SectionHeading>
              {summary.data.byClient.length === 0 ? (
                <EmptyState compact title="No client work in this period." />
              ) : (
                <div className="space-y-2">
                  {summary.data.byClient.map((c) => (
                    <MoneyRow
                      key={c.clientId ?? "none"}
                      label={c.clientName ?? "No client"}
                      sub={`of ${formatMoney(c.offeredCents)} offered`}
                      value={formatMoney(c.paidCents)}
                      tone="neutral"
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <section data-testid="report-exports">
          <SectionHeading>Export</SectionHeading>
          <div className="space-y-2">
            <Button variant="ghost" block data-testid="export-income" onClick={() => void exportIncome()}>
              Income CSV — gigs and services
            </Button>
            <Button variant="ghost" block data-testid="export-expenses" onClick={() => void exportExpenses()}>
              Expenses CSV
            </Button>
            <Button
              variant="ghost"
              block
              data-testid="export-summary"
              disabled={summary.data === undefined}
              onClick={exportSummary}
            >
              Monthly summary CSV
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Exports cover the period selected above.
            {offline && " Income and expenses export from your local data, even offline."}
          </p>
        </section>
      </main>
    </>
  );
}

/** Date stamp for filenames — YYYY-MM-DD, local. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
