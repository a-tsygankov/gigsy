import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { ReportFilters } from "../lib/types.ts";
import { formatMoney } from "../lib/format.ts";
import { toCsv, downloadCsv } from "../lib/csv.ts";
import { buildInvoice, formatInvoiceNumber } from "../lib/invoice.ts";
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
import { useSettings } from "./settings/useSettings.ts";

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

/** Where the Create invoice button goes. Exported for its own test —
 *  a wrong query string here is a silently empty invoice, not a crash. */
export function invoiceHref(
  clientId: string,
  number: number,
  filters: { from?: number; to?: number },
): string {
  const params = new URLSearchParams({ client: clientId, n: String(number) });
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  return `/reports/invoice?${params.toString()}`;
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
  const navigate = useNavigate();
  const { settings, updateAsync } = useSettings();

  const [rangeKey, setRangeKey] = useState<RangeKey>("ytd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [clientId, setClientId] = useState("");
  const [invoiceEmpty, setInvoiceEmpty] = useState(false);
  const [invoiceError, setInvoiceError] = useState(false);
  // Create invoice awaits a network round trip (the number allocation)
  // before navigating, so the button needs to visibly do something on a
  // slow connection instead of looking dead — and this also guards
  // against a second click allocating a second number while the first
  // write is still in flight.
  const [invoiceCreating, setInvoiceCreating] = useState(false);
  // `useNavigate`'s returned function does not deactivate on unmount —
  // react-router's `activeRef` is set in a layout effect on mount and
  // never reset — so a `navigate` that resolves after the user has
  // left this screen would still fire and drag them back. This ref is
  // the guard: it's true only while Reports is mounted.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

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

  /** Allocate a number and open the document.
   *
   *  Allocating on the click, not in an effect on the invoice route:
   *  StrictMode double-invokes effects in development, so an allocating
   *  effect burns two numbers per open. A handler runs once.
   *
   *  Nothing is allocated for an invoice with no lines — the counter is
   *  only spent on a document that exists. */
  async function createInvoice() {
    if (clientId === "" || settings === undefined) return;
    setInvoiceCreating(true);
    setInvoiceError(false);
    try {
      // Loaded here rather than from a query: gigs, services and
      // expenses follow `exportIncome`/`exportExpenses`, which each
      // read the local ledger on demand — this does too, so the
      // invoice sees exactly what the CSVs would. The client NAME
      // comes from the `clients` query above instead, since the filter
      // already holds it; re-fetching the same list here would just
      // duplicate that query's cache.
      const [gigList, serviceList, expenseList] = await Promise.all([
        data.listGigs(),
        data.listServices(),
        data.listExpenses(),
      ]);
      const next = settings.invoiceNextNumber;
      const doc = buildInvoice({
        gigs: gigList,
        services: serviceList,
        expenses: expenseList,
        clientId,
        clientName: clients.data?.find((c) => c.id === clientId)?.name ?? "",
        filters,
        business: {
          name: settings.businessName,
          address: settings.businessAddress,
          contact: settings.businessContact,
          taxId: settings.businessTaxId,
          paymentDetails: settings.businessPaymentDetails,
        },
        number: formatInvoiceNumber(next),
        issuedAt: Date.now(),
        termsDays: settings.invoicePaymentTermsDays,
      });
      // "Nothing to bill" and "nothing we could price" are different
      // answers, and only the first should refuse to open a document. A
      // client whose only qualifying work is unpriced still deserves the
      // page that tells them so — refusing here would hide the warning
      // behind an empty state that says the opposite.
      if (
        doc.lines.length === 0 &&
        doc.expenses.length === 0 &&
        doc.unpricedGigs.length === 0
      ) {
        setInvoiceEmpty(true);
        return;
      }
      setInvoiceEmpty(false);
      // Await the write, and do not open the document if it failed.
      //
      // `updateSettings` is NOT in the offline outbox — data-service.ts
      // forwards it straight to the API — while the invoice itself builds
      // from the local ledger and would render happily offline. Fire and
      // forget would therefore print a number, have the PATCH reject, and
      // let `useSettings`'s `onError` roll the counter back, so the NEXT
      // invoice reuses a number already on somebody's desk. Gaps in a
      // sequence are ordinary; repeats are the one thing this counter
      // exists to prevent.
      try {
        await updateAsync({ invoiceNextNumber: next + 1 });
      } catch {
        setInvoiceError(true);
        return;
      }
      // Only navigate if this screen is still the one the user is
      // looking at — see the `alive` ref above.
      if (alive.current) navigate(invoiceHref(clientId, next, filters));
    } finally {
      setInvoiceCreating(false);
    }
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
              disabled={invoiceCreating}
              onChange={(e) => {
                setClientId(e.target.value);
                setInvoiceEmpty(false);
                setInvoiceError(false);
              }}
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
                {/* Completed-but-unpaid work only — the same question
                    the dashboard's "Unpaid" tile answers, so the two
                    screens agree. Leads and confirmed gigs are money
                    expected, not money owed. */}
                <Tile
                  label="Still owed"
                  value={formatMoney(summary.data.totals.owedCents)}
                  tone="warn"
                  testId="tile-owed"
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

        <section data-testid="report-invoice">
          <SectionHeading>Invoice</SectionHeading>
          {clientId === "" ? (
            <p className="text-sm text-slate-600" data-testid="invoice-needs-client">
              An invoice is addressed to one client. Choose one above and it will
              cover their unpaid work in the period selected.
            </p>
          ) : (
            <>
              <Button
                variant="ghost"
                block
                data-testid="invoice-create"
                disabled={settings === undefined || invoiceCreating}
                onClick={() => void createInvoice()}
              >
                {invoiceCreating ? "Creating…" : "Create invoice"}
              </Button>
              {invoiceEmpty && (
                <p className="mt-2 text-sm text-slate-600" data-testid="invoice-empty">
                  Nothing to invoice — this client has no unpaid work in the period
                  selected.
                </p>
              )}
              {invoiceError && (
                <p className="mt-2 text-sm text-red-600" data-testid="invoice-error">
                  Couldn't reserve an invoice number — you may be offline. The
                  document wasn't created, so nothing has been used up.
                </p>
              )}
            </>
          )}
        </section>

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
