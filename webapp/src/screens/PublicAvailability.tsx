/**
 * The public availability page (Phase 12, Task 4).
 *
 * The only screen in the app with no account behind it. An agency
 * opens this on a phone between calls, so it is one column, large
 * type, no navigation, and nothing to interact with — there is no
 * login, no reply form and no booking. It answers one question and
 * stops.
 *
 * It deliberately does NOT render the app chrome: no AppHeader, no
 * TabBar, no sync badge. Those belong to someone who is signed in, and
 * showing them here would invite a stranger to try.
 *
 * Every time on this page is in the OWNER's timezone, said out loud in
 * the header. A reader in another country who assumes otherwise books
 * an hour that does not exist for the person they are booking.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  fetchPublicAvailability,
  type AvailabilityResult,
} from "../lib/availability-api.ts";
import {
  describeBasis,
  formatAsOf,
  formatLastDayCovered,
  formatZoneLabel,
  groupSlotsByDay,
} from "../lib/availability.ts";

/** The shell every state shares, so a failure looks like a page rather
 *  than a broken one. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-10 text-slate-900">
      <div className="mx-auto w-full max-w-lg">{children}</div>
      <p className="mx-auto mt-10 w-full max-w-lg text-center text-xs text-slate-400">
        Shared with Gigsy
      </p>
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm"
      data-testid="availability-message"
    >
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

export function PublicAvailability() {
  const { token = "" } = useParams();
  const [result, setResult] = useState<AvailabilityResult | null>(null);

  useEffect(() => {
    let live = true;
    void fetchPublicAvailability(token).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [token]);

  if (result === null) {
    return (
      <Shell>
        <div
          className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-white"
          data-testid="availability-loading"
        />
      </Shell>
    );
  }

  if (result.status === "not-found") {
    // Expired, revoked and never-existed are one message on purpose:
    // the server does not distinguish them, because telling a holder
    // that a link *used* to work says something about the owner's
    // relationship with them.
    return (
      <Shell>
        <Message
          title="This link isn't active"
          body="It may have been replaced or turned off. Ask whoever shared it for a current one."
        />
      </Shell>
    );
  }

  if (result.status === "unavailable") {
    return (
      <Shell>
        <Message
          title="Couldn't load availability"
          body="Something went wrong reaching the server. Try again in a moment."
        />
      </Shell>
    );
  }

  const { availability } = result;
  const locale = navigator.language;
  const days = groupSlotsByDay(
    availability.slots,
    availability.timeZone,
    availability.generatedAt,
    locale,
  );
  const who =
    availability.displayName === null
      ? "Availability"
      : `${availability.displayName}'s availability`;

  return (
    <Shell>
      <header>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="availability-title">
          {who}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          All times in{" "}
          <span className="font-medium text-slate-700">
            {formatZoneLabel(availability.timeZone, availability.generatedAt, locale)}
          </span>
        </p>
        <p className="mt-1 text-xs text-slate-500" data-testid="availability-asof">
          As of {formatAsOf(availability.generatedAt, availability.timeZone, locale)}
        </p>
      </header>

      {days.length === 0 ? (
        // A full calendar is an answer, not a failure. The dashed
        // empty-state box the rest of the app uses would read as
        // "something didn't load" to someone who has never seen this
        // page before, so this states the result in words.
        <div
          className="mt-6 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm"
          data-testid="availability-empty"
        >
          <p className="text-sm font-semibold text-slate-700">
            No free time in this period
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {/* Deliberately not "it's all booked". The page cannot tell
                a full calendar from someone who simply does not work
                these days, and guessing would state a reason that is
                sometimes false — and reveal something either way. */}
            Nothing available between now and{" "}
            {formatLastDayCovered(
              availability.horizonEndsAt,
              availability.timeZone,
              locale,
            )}
            .
          </p>
        </div>
      ) : (
        <ol className="mt-6 space-y-4" data-testid="availability-days">
          {days.map((day) => (
            <li
              key={day.key}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <h2 className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-slate-900">{day.label}</span>
                {day.relative !== null && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {day.relative}
                  </span>
                )}
              </h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {day.slots.map((slot) => (
                  <li
                    key={slot.key}
                    data-testid="availability-slot"
                    // slate-200, not slate-100: the ramp inverts in dark
                    // mode, where slate-100 lands on exactly the same
                    // value as the card behind it and the chips vanish.
                    // Tabular numerals so a column of times lines up.
                    className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium tabular-nums text-slate-700"
                  >
                    {slot.label}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-6 text-xs leading-relaxed text-slate-500" data-testid="availability-basis">
        {describeBasis(availability.basedOn)}
      </p>
    </Shell>
  );
}
