/**
 * One invoice, as a document rather than a screen.
 *
 * Everything here exists to be printed. The PDF is the browser's, not
 * ours: `styles/print.css` hides the app's chrome and this component's
 * own Print button, so what comes out is the document and nothing else.
 * That choice is the spec's, and the reason is text — PDF core fonts
 * are Latin-1, and gig titles and client names come from forwarded
 * emails and photographs.
 *
 * It reads its inputs from the URL so it is refreshable, linkable, and
 * a legal destination for a help `navigate` step. It allocates nothing
 * and writes nothing: the number was spent by whoever opened it.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { useData } from "../lib/app-context.tsx";
import { buildInvoice, formatInvoiceNumber } from "../lib/invoice.ts";
import type { InvoiceDocument } from "../lib/invoice.ts";
import { formatMoney } from "../lib/format.ts";
import { isoDate } from "../lib/report-export.ts";
import type { ReportFilters } from "../lib/types.ts";
import { useSettings } from "./settings/useSettings.ts";
import { AppHeader, Button, Card, ListSkeleton } from "../components/index.ts";

export interface InvoiceParams {
  clientId: string;
  number: number;
  filters: ReportFilters;
}

/** The URL is the input. Exported for its own test: a hand-edited or
 *  truncated link must produce a refusal, never a document with a
 *  nonsense number printed on it. */
export function invoiceParams(search: URLSearchParams): InvoiceParams | null {
  const clientId = search.get("client");
  if (clientId === null || clientId === "") return null;

  const n = Number(search.get("n"));
  if (!Number.isInteger(n) || n < 1) return null;

  const filters: ReportFilters = {};
  const from = Number(search.get("from"));
  const to = Number(search.get("to"));
  if (Number.isFinite(from) && search.get("from") !== null) filters.from = from;
  if (Number.isFinite(to) && search.get("to") !== null) filters.to = to;

  return { clientId, number: n, filters };
}

/** The sentence above the list of gigs that could not be priced.
 *  Exported for its own test: it is the only place the user is told
 *  that work was deliberately left off a bill, so the wording is
 *  behaviour, not decoration. Takes just the field it needs so a test
 *  does not have to build a whole document. */
export function unpricedNotice(doc: Pick<InvoiceDocument, "unpricedGigs">): string {
  return doc.unpricedGigs.length === 1
    ? "1 completed gig has no price set, so it is not on this invoice:"
    : `${doc.unpricedGigs.length} completed gigs have no price set, so they are not on this invoice:`;
}

export function Invoice() {
  const [search] = useSearchParams();
  const api = useData();
  const { settings } = useSettings();
  const params = invoiceParams(search);

  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.listServices() });
  const expenses = useQuery({ queryKey: ["expenses"], queryFn: () => api.listExpenses() });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });

  // Captured once per mount, not read fresh inside the memo below: the
  // memo's own deps don't include time, so if `Date.now()` were called
  // there directly it would still re-run — with a newer timestamp —
  // every time a query resolves (gigs, then settings, then clients each
  // land separately), shifting the printed issue date mid-session
  // before anyone even prints. Stabilizing it here means one page view
  // prints one issue date no matter how the queries interleave. It does
  // NOT make the link itself replayable — the same URL opened tomorrow
  // still stamps tomorrow's date, because the issue date is not part of
  // the URL. Making this screen a pure function of its link end to end
  // would need an `issued` query param threaded from Task 4's
  // allocation step, which is out of scope here.
  const issuedAt = useMemo(() => Date.now(), []);

  // Every field `buildInvoice` reads defaults harmlessly when a query
  // hasn't resolved yet (`gigs.data ?? []`, an empty client name), so
  // nothing here would throw if the memo ran early. But "harmlessly"
  // is the problem: an invoice built from gigs that haven't loaded yet
  // looks exactly like a client with no unpaid work, and a client name
  // that hasn't loaded yet renders as "Billed to " with nothing after
  // it. Both are indistinguishable from the real, resolved answer, so
  // the memo waits for all five sources rather than the two (`params`,
  // `settings`) that happen not to crash without.
  const loading =
    settings === undefined ||
    gigs.isPending ||
    services.isPending ||
    expenses.isPending ||
    clients.isPending;

  const doc = useMemo(() => {
    // `settings === undefined` is implied by `loading` above; repeated
    // here only so TypeScript narrows `settings` for the object built
    // below — `loading` being false doesn't carry that proof on its own.
    if (params === null || loading || settings === undefined) return null;
    return buildInvoice({
      gigs: gigs.data ?? [],
      services: services.data ?? [],
      expenses: expenses.data ?? [],
      clientId: params.clientId,
      clientName: clients.data?.find((c) => c.id === params.clientId)?.name ?? "",
      filters: params.filters,
      business: {
        name: settings.businessName,
        address: settings.businessAddress,
        contact: settings.businessContact,
        taxId: settings.businessTaxId,
        paymentDetails: settings.businessPaymentDetails,
      },
      number: formatInvoiceNumber(params.number),
      issuedAt,
      termsDays: settings.invoicePaymentTermsDays,
    });
  }, [params, loading, settings, gigs.data, services.data, expenses.data, clients.data, issuedAt]);

  if (params === null) {
    return (
      <>
        <AppHeader title="Invoice" />
        <Card>
          <p data-testid="invoice-bad-link">
            This invoice link is incomplete. Start again from{" "}
            <Link to="/reports">Reports</Link>.
          </p>
        </Card>
      </>
    );
  }

  if (doc === null) {
    // Either still loading (see `loading` above) or a one-render gap
    // right after it flips to false and before the memo has produced
    // `doc` — both look the same to the user, so both get the same
    // skeleton rather than a blank page, which on a route whose whole
    // point is to be shared and reopened would read as a broken link.
    return (
      <>
        <AppHeader title="Invoice" />
        <Card>
          <ListSkeleton rows={3} />
        </Card>
      </>
    );
  }

  const empty = doc.lines.length === 0 && doc.expenses.length === 0;

  return (
    <>
      <AppHeader title="Invoice" />
      <article data-testid="invoice-document" className="space-y-4 print:space-y-3">
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              {doc.business.name === null ? (
                <p data-testid="invoice-no-business" className="text-sm text-amber-700">
                  No business details yet — add them in{" "}
                  <Link to="/settings">Settings</Link> and they will appear here.
                </p>
              ) : (
                <p className="font-semibold" data-testid="invoice-business-name">
                  {doc.business.name}
                </p>
              )}
              {doc.business.address !== null && (
                <p className="whitespace-pre-line text-sm">{doc.business.address}</p>
              )}
              {doc.business.contact !== null && (
                <p className="text-sm">{doc.business.contact}</p>
              )}
              {doc.business.taxId !== null && (
                <p className="text-sm">Tax no. {doc.business.taxId}</p>
              )}
            </div>
            <div className="text-right">
              <p className="font-semibold" data-testid="invoice-number">{doc.number}</p>
              <p className="text-sm">Issued {isoDate(doc.issuedAt)}</p>
              <p className="text-sm" data-testid="invoice-due">Due {isoDate(doc.dueAt)}</p>
            </div>
          </div>
          <p className="mt-3 text-sm" data-testid="invoice-client">
            Billed to {doc.client.name}
          </p>
        </Card>

        {doc.unpricedGigs.length > 0 && (
          <Card>
            {/* The one thing the document knows and the user cannot
                otherwise find out. `buildInvoice` drops work it cannot
                price rather than billing $0.00; without this the user
                prints, sends, and under-bills in silence. Deliberately
                on the document itself, not a toast on the previous
                screen — it has to be visible at the moment somebody is
                about to send this. */}
            <p className="text-sm text-amber-700" data-testid="invoice-unpriced">
              {unpricedNotice(doc)}
            </p>
            <ul className="mt-1 text-sm text-amber-700">
              {doc.unpricedGigs.map((g) => (
                <li key={g.id}>{g.description}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-600">
              Set a rate or an amount on the gig and create the invoice again.
            </p>
          </Card>
        )}

        {empty ? (
          <Card>
            <p data-testid="invoice-empty-doc">
              Nothing to invoice — this client has no unpaid work in the period
              selected.
            </p>
          </Card>
        ) : (
          <Card>
            <table className="w-full text-sm" data-testid="invoice-lines">
              <tbody>
                {doc.lines.map((line, i) => (
                  <tr key={`w${i}`}>
                    <td>{isoDate(line.date)}</td>
                    <td>{line.description}</td>
                    <td className="text-right">{formatMoney(line.amountCents)}</td>
                  </tr>
                ))}
                {doc.expenses.map((line, i) => (
                  <tr key={`e${i}`} data-testid="invoice-expense-line">
                    <td>{isoDate(line.date)}</td>
                    <td>{line.description} (expense)</td>
                    <td className="text-right">{formatMoney(line.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-right font-semibold" data-testid="invoice-total">
              Total {formatMoney(doc.totalCents)}
            </p>
          </Card>
        )}

        {doc.business.paymentDetails !== null && (
          <Card>
            <p className="whitespace-pre-line text-sm" data-testid="invoice-payment-details">
              {doc.business.paymentDetails}
            </p>
          </Card>
        )}
      </article>

      <Button block data-testid="invoice-print" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
    </>
  );
}
