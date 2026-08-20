/**
 * What the job IS, as agreed.
 *
 * Read-only on purpose. This half of a gig changes when the client
 * changes it — rarely, and deliberately — while the work card below it
 * changes on the day, in a hurry, with one thumb. Putting both in one
 * form is what made the old screen 620 lines and made it possible to
 * knock the planned start time sideways while recording that you
 * finished late.
 *
 * EMPTY ROWS ARE OMITTED, with two exceptions. A card of "—"s tells you
 * nothing you could not have guessed, and it buries the rows that do say
 * something. The exceptions are the two facts whose absence is itself
 * actionable: WHEN (a gig with no date blocks no time, reaches no
 * calendar and appears in no date-filtered list — a silent omission
 * would hide that) and HOW IT PAYS (a fixed gig with no fee is what the
 * dashboard cannot count, and an hourly gig with no rate cannot be
 * priced at all). Those two always render, and say what is missing.
 */
import { formatLocalMoment, msToLocalInput } from "../../lib/datetime.ts";
import { formatDuration, formatMoney } from "../../lib/format.ts";
import { ButtonLink } from "../../components/index.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import type { Gig } from "../../lib/types.ts";
import type { ReactNode } from "react";

function Row({
  label,
  testId,
  value,
  canonical,
}: {
  label: string;
  testId?: string;
  value: ReactNode;
  /** A machine-readable copy of the value, where one exists. What a row
   *  READS is localised — "Sat, Sep 12, 2:07 PM" in one locale, "sam. 12
   *  sept." in another — so it is not something a test can assert a
   *  stored moment against. Same trick, and the same reason, as
   *  DateTimeField's trigger. */
  canonical?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span
        data-testid={testId}
        data-value={canonical}
        className="min-w-0 text-right text-sm text-slate-900"
      >
        {value}
      </span>
    </div>
  );
}

/** The plan, in one line: when it starts and how long it is booked for.
 *  Never the actuals — those are the work card's, and keeping them apart
 *  on screen is the whole point of the split. */
function whenLine(gig: Gig): string {
  const moment = gig.dateTime === null ? "No date yet" : formatLocalMoment(gig.dateTime);
  const length = gig.durationMinutes === null ? null : formatDuration(gig.durationMinutes);
  return length === null || length === "" ? moment : `${moment} · ${length}`;
}

/** How it pays, as agreed — not what it earned. An hourly gig's real
 *  figure depends on the time worked, which lives on the work card. */
function payLine(gig: Gig): string {
  if (gig.payType === "hourly") {
    return gig.hourlyRateCents === null
      ? "Hourly — no rate set"
      : `${formatMoney(gig.hourlyRateCents)} / hour`;
  }
  return gig.amountOfferedCents === null
    ? "Fixed fee — not set"
    : `${formatMoney(gig.amountOfferedCents)} fixed fee`;
}

export function JobCard({
  gig,
  clientName,
}: {
  gig: Gig;
  /** Resolved by the hub, which is where the clients query lives. Null
   *  means no client; the row is then omitted rather than claiming "No
   *  client", which the list has room to say and this card does not. */
  clientName: string | null;
}) {
  return (
    <Card data-testid="gig-job-card">
      <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-sm">Job</CardTitle>
        <ButtonLink
          to={`/gigs/${gig.id}/edit`}
          data-testid="gig-edit"
          variant="ghost"
          size="sm"
          // 44px, the design system's tap minimum, without the padding a
          // full-size button would spend on a card header row.
          className="min-h-11"
        >
          Edit
        </ButtonLink>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {clientName !== null && <Row label="Client" testId="job-client" value={clientName} />}
        {gig.title !== null && gig.title.trim() !== "" && (
          <Row label="Title" testId="job-title" value={gig.title} />
        )}
        <Row
          label="When"
          testId="job-when"
          value={whenLine(gig)}
          canonical={msToLocalInput(gig.dateTime)}
        />
        {gig.location !== null && gig.location.trim() !== "" && (
          <Row label="Where" testId="job-location" value={gig.location} />
        )}
        <Row label="Pays" testId="job-pay" value={payLine(gig)} />
        {gig.notes !== null && gig.notes.trim() !== "" && (
          <div className="pt-2" data-testid="job-notes">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </span>
            {/* The line breaks someone typed are part of what they
                wrote — a parking instruction under a contact name. */}
            <p className="whitespace-pre-line text-sm text-slate-700">{gig.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
