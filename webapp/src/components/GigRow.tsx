/**
 * One gig as a card row (design system, components/data/GigRow): the
 * heading, a `client · date · location` line, the lifecycle pill and
 * the money.
 *
 * Extracted from the Gigs tab so that the gig picker (GigPicker.tsx)
 * can list gigs in exactly the shape the tab does. Before this, three
 * `<select>`s each invented a one-line label for a gig — title only,
 * title + date, location + date — and none of them could tell apart a
 * recurring job ("Arrange a tasting") booked for several clients on
 * several dates. One row, rendered by both, cannot drift.
 *
 * Two modes, one body. The tab needs a row that NAVIGATES (a `CardLink`,
 * which is a react-router `Link`); the picker needs one that is CHOSEN
 * (a `<button>`, with `aria-pressed` for the current choice). They are
 * a discriminated union rather than an `href?`/`onClick?` pair so that
 * a caller cannot ask for both, or neither.
 *
 * `gigSummary` is exported on its own because the picker's closed
 * trigger states the chosen gig in the same two lines, without being a
 * row at all.
 */
import { CardLink, cardClasses } from "./Card.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { formatMoney } from "../lib/format.ts";
import { formatLocalMoment } from "../lib/datetime.ts";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import { isPaid, storedOrDerivedExpectedCents } from "../lib/gig-pay.ts";
import type { Gig } from "../lib/types.ts";

/** Same formatter DateTimeField's trigger uses, so the line you read in
 *  the list and the line you read on the form are the same line. */
export function gigDateLine(ms: number | null): string {
  return ms === null ? "No date yet" : formatLocalMoment(ms);
}

export interface GigSummary {
  /** `gigDisplayTitle`: title → first line of notes → client. */
  heading: string;
  /** `client · date · location`, minus whatever is missing. */
  sub: string;
}

/**
 * The two lines that identify a gig on screen.
 *
 * `clientName` is what the CALLER knows the client is called — null for
 * a gig with no client, and also for one whose client this device has
 * not loaded, which is why it is a parameter rather than a lookup.
 */
export function gigSummary(gig: Gig, clientName: string | null): GigSummary {
  const heading = gigDisplayTitle(gig, clientName);
  // The client only repeats below when it is not already the heading —
  // losing it entirely would be worse than repeating.
  const sub = [
    clientName !== null && clientName !== heading ? clientName : null,
    gigDateLine(gig.dateTime),
    gig.location,
  ].filter((part): part is string => part !== null);
  return { heading, sub: sub.join(" · ") };
}

interface GigRowContent {
  gig: Gig;
  clientName: string | null;
  /** Show the "not synced yet" dot. The Gigs tab reads this off the
   *  outbox; the picker never sets it. */
  unsynced?: boolean;
}

export type GigRowProps = GigRowContent &
  (
    | {
        /** Link mode: the row navigates here. */
        to: string;
      }
    | {
        /** Button mode: the row is a choice. */
        onSelect: () => void;
        /** Whether this is the current choice — rendered as
         *  `aria-pressed` and a ring, never as colour alone. */
        selected?: boolean;
        /** The button's own id; the picker passes `<picker>-row-<gig>`. */
        testId?: string;
      }
  );

export function GigRow(props: GigRowProps) {
  const { gig, clientName, unsynced = false } = props;
  const { heading, sub } = gigSummary(gig, clientName);
  // What was paid if anything was, otherwise what the gig is expected
  // to earn. Not `amountOfferedCents`: on an hourly gig that is only an
  // optional override, so the row showed no amount at all for a rated
  // shift.
  const money = gig.amountPaidCents ?? storedOrDerivedExpectedCents(gig);

  const body = (
    <div className="flex items-start justify-between gap-3">
      {unsynced && (
        <span
          data-testid="gig-unsynced"
          // Not colour alone. role="img" is what makes the label legal:
          // ARIA forbids naming a bare span (role generic), so without
          // it the label is dropped from the accessibility tree and the
          // marker really is colour-only.
          role="img"
          title="Not synced yet"
          aria-label="Not synced yet"
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
        />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{heading}</p>
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {/* Paid-ness is derived from the money, not the status
            (lib/gig-pay.ts) — a confirmed gig paid in full up front has
            nowhere else in this row to say so, since `money` above
            shows the figure but not whether it is settled. */}
        <StatusPill status={gig.status} paid={isPaid(gig)} />
        {money !== null && (
          <span className="text-sm font-semibold text-slate-800">{formatMoney(money)}</span>
        )}
      </div>
    </div>
  );

  if ("to" in props) {
    return <CardLink to={props.to}>{body}</CardLink>;
  }

  const selected = props.selected ?? false;
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-pressed={selected}
      onClick={props.onSelect}
      // The card recipe, on a button: `w-full text-left` because a
      // button is inline and centred by default, where a link card is
      // a block. The ring is the selected state's second signal beside
      // `aria-pressed`, in the accent the focus ring already uses.
      className={cardClasses({
        interactive: true,
        className: `w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          selected ? "border-emerald-500 ring-2 ring-emerald-500" : ""
        }`,
      })}
    >
      {body}
    </button>
  );
}
