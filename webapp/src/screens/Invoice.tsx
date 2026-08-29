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
import { Link, useSearchParams } from "react-router-dom";
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
  issuedAt: number;
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

  // As strict as the number check above: a document printing "Invalid
  // Date" is worse than a link that admits it is broken, and this is
  // the field that fixes the issue date to the link — see the comment
  // on `issuedAt` below.
  const issuedAt = Number(search.get("issued"));
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return null;

  const filters: ReportFilters = {};
  // The raw string is the thing to check, not the coerced number:
  // `Number("")` is `0`, so a bound present but empty (`?from=`) would
  // otherwise become `filters.from = 0` — a real, silently-wrong bound
  // (epoch 0) rather than the "no bound" the empty value actually
  // means. That is a hand-edited link inventing an answer instead of
  // refusing, which is exactly what `clientId` and `n` above refuse to
  // do — this guard exists so an empty bound gets the same treatment.
  const rawFrom = search.get("from");
  if (rawFrom !== null && rawFrom !== "" && Number.isFinite(Number(rawFrom))) {
    filters.from = Number(rawFrom);
  }
  const rawTo = search.get("to");
  if (rawTo !== null && rawTo !== "" && Number.isFinite(Number(rawTo))) {
    filters.to = Number(rawTo);
  }

  return { clientId, number: n, issuedAt, filters };
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
  const { settings, loadError: settingsError } = useSettings();
  // `invoiceParams` returns a fresh object on every call, so without
  // this the identity of `params` changes on every render regardless
  // of `search`, and the `doc` memo below — which depends on `params`
  // — recomputes every render for no reason.
  const params = useMemo(() => invoiceParams(search), [search]);

  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.listServices() });
  const expenses = useQuery({ queryKey: ["expenses"], queryFn: () => api.listExpenses() });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });

  // `isPending` is false once a query has *errored*, not just once it
  // has succeeded — so a failed read must be checked for on its own,
  // ahead of `loading` below. Left unchecked, an errored `gigs` read
  // yields `gigs.data ?? [] → []`, which looks exactly like a client
  // with no unpaid work: the document renders in full — number, dates,
  // client name — captioned "Nothing to invoice", print button live.
  // That is the same silent under-bill `unpricedGigs` exists to
  // prevent, arriving through a different door.
  const error =
    gigs.isError || services.isError || expenses.isError || clients.isError ||
    settingsError !== null;

  // Every field `buildInvoice` reads defaults harmlessly when a query
  // hasn't resolved yet (`gigs.data ?? []`, an empty client name), so
  // nothing here would throw if the memo ran early. But "harmlessly"
  // is the problem: an invoice built from gigs that haven't loaded yet
  // looks exactly like a client with no unpaid work, and a client name
  // that hasn't loaded yet renders as "Billed to " with nothing after
  // it. Both are indistinguishable from the real, resolved answer, so
  // the memo waits for all five sources rather than the two (`params`,
  // `settings`) that happen not to crash without. Deliberately not
  // combined with `error` here — `isPending` is already false once a
  // query has errored, so `loading` on its own can't tell "still
  // loading" from "failed"; every caller below checks `error` first
  // and only consults `loading` once `error` is already known false,
  // which is also what lets TypeScript narrow `settings` past this
  // point without a separate `settings === undefined` check.
  const loading =
    settings === undefined ||
    gigs.isPending ||
    services.isPending ||
    expenses.isPending ||
    clients.isPending;

  const doc = useMemo(() => {
    if (params === null || error || loading) return null;
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
      // From the URL, never `Date.now()`: the number, the issue date
      // and the due date are all fixed by the link, and nothing about
      // this invoice is stored — so the URL is its only identity.
      // Reading the clock here would mean reopening the same link
      // tomorrow prints the same number with a different issue and due
      // date than the copy already on somebody's desk.
      issuedAt: params.issuedAt,
      termsDays: settings.invoicePaymentTermsDays,
    });
  }, [params, error, loading, settings, gigs.data, services.data, expenses.data, clients.data]);

  if (params === null) {
    return (
      <>
        <AppHeader title="Invoice" />
        <main className="mx-auto max-w-lg space-y-4 p-4">
          <Card>
            <p data-testid="invoice-bad-link">
              This invoice link is incomplete. Start again from{" "}
              <Link to="/reports">Reports</Link>.
            </p>
          </Card>
        </main>
      </>
    );
  }

  if (error) {
    return (
      <>
        <AppHeader title="Invoice" />
        <main className="mx-auto max-w-lg space-y-4 p-4">
          <Card>
            <p className="text-sm text-red-600" data-testid="invoice-load-error">
              Couldn't load this invoice. Check your connection and try again — no
              invoice number has been used up.
            </p>
          </Card>
        </main>
      </>
    );
  }

  if (loading || doc === null) {
    // `doc === null` cannot actually happen once `loading` is false:
    // the memo's own guard is `params === null || error || loading` —
    // the same three things already excluded above — so the two
    // conditions never diverge. Checked anyway because TypeScript
    // can't see that from here; `doc` narrows to non-null below only
    // because of this line.
    return (
      <>
        <AppHeader title="Invoice" />
        <main className="mx-auto max-w-lg space-y-4 p-4">
          <Card>
            <ListSkeleton rows={3} />
          </Card>
        </main>
      </>
    );
  }

  const empty = doc.lines.length === 0 && doc.expenses.length === 0;

  return (
    <>
      <AppHeader title="Invoice" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
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
      </main>
    </>
  );
}
