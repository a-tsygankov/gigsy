/**
 * Reading a user's busy time for the public availability page
 * (Phase 12, Task 3).
 *
 * This is the only code path in the app where an unauthenticated
 * stranger's request causes Gigsy to talk to Google on a user's
 * behalf, which drives two rules:
 *
 * 1. **It never writes.** Elsewhere an unreadable or revoked token is
 *    self-healed by clearing it (calendar/token.ts) — the right thing
 *    when the user is present and can reconnect. Here it would mean a
 *    visitor's page load silently disconnecting someone's calendar, so
 *    this path decrypts directly and gives up quietly instead. The
 *    authenticated routes and the cron still do the healing.
 * 2. **Every failure is null**, never an empty busy list. "We could not
 *    look" and "your calendar is clear" produce very different pages,
 *    and only one of them is honest.
 *
 * Note the cost this accepts: a request to the public link can cost a
 * token mint and a freebusy call. The rate limiter in the route is
 * what keeps that bounded.
 */
import type { Bindings } from "../env.ts";
import { decryptString } from "../auth/crypto.ts";
import { UsersRepo } from "../repos/users.ts";
import type { CalendarBusyReader } from "../services/availability.ts";
import { mintAccessToken, queryFreeBusy } from "./google-calendar.ts";

export interface FreeBusyDeps {
  mintAccessToken: typeof mintAccessToken;
  queryFreeBusy: typeof queryFreeBusy;
}

export const defaultFreeBusyDeps: FreeBusyDeps = { mintAccessToken, queryFreeBusy };

export function makeCalendarBusyReader(
  env: Bindings,
  deps: FreeBusyDeps = defaultFreeBusyDeps,
): CalendarBusyReader {
  return async (userId, timeMinMs, timeMaxMs) => {
    const usersRepo = UsersRepo.for(env.DB);
    const user = await usersRepo.get(userId);
    if (user?.googleRefreshTokenEnc == null) return null;

    // decryptString rather than resolveRefreshToken: see rule 1 above.
    const refreshToken = await decryptString(
      user.googleRefreshTokenEnc,
      env.REFRESH_TOKEN_ENC_KEY,
    );
    if (refreshToken === null) return null;

    const minted = await deps.mintAccessToken({
      refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    // "revoked" is actionable, but not by a stranger's page load — the
    // next authenticated sync will disconnect and prompt properly.
    if (minted === "revoked" || minted === null) return null;

    const settings = await usersRepo.getSettings(userId);
    return deps.queryFreeBusy({
      accessToken: minted.accessToken,
      timeMinMs,
      timeMaxMs,
      // "primary" is the point: it holds the dentist, the school run and
      // the gig booked through an agency that never reached the app —
      // exactly what Gigsy does not know. The target calendar is asked
      // too, for the case where it is a dedicated one someone has also
      // been adding to by hand; queryFreeBusy dedupes when they match.
      calendarIds: ["primary", settings.calendarTargetId],
    });
  };
}
