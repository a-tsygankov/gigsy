/**
 * The scheduled fan-out (docs/plan.md §9): every connected user gets
 * a sync pass; one user's failure never blocks the rest, and revoked
 * consent disconnects that user instead of erroring forever.
 */
import type { Bindings } from "../env.ts";
import { UsersRepo } from "../repos/users.ts";
import { decryptString } from "../auth/crypto.ts";
import {
  CalendarClient,
  mintAccessToken,
  type MintOptions,
} from "./google-calendar.ts";
import { syncUserGigs, type CalendarClientLike } from "./sync-service.ts";
import { log } from "../logger.ts";

export interface CronDeps {
  mintAccessToken: (options: MintOptions) => ReturnType<typeof mintAccessToken>;
  makeClient: (accessToken: string) => CalendarClientLike;
}

const defaultDeps: CronDeps = {
  mintAccessToken,
  makeClient: (accessToken) => new CalendarClient(accessToken),
};

export interface CronSummary {
  usersSynced: number;
  usersFailed: number;
}

export async function runCalendarCron(
  env: Bindings,
  deps: CronDeps = defaultDeps,
): Promise<CronSummary> {
  const usersRepo = UsersRepo.for(env.DB);
  const summary: CronSummary = { usersSynced: 0, usersFailed: 0 };

  for (const user of await usersRepo.listConnected()) {
    try {
      const refreshToken = await decryptString(
        user.googleRefreshTokenEnc!,
        env.REFRESH_TOKEN_ENC_KEY,
      );
      if (refreshToken === null) {
        summary.usersFailed++;
        log.warn("calendar cron: stored token unreadable", { userId: user.id });
        continue;
      }
      const minted = await deps.mintAccessToken({
        refreshToken,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      });
      if (minted === "revoked") {
        await usersRepo.setGoogleRefreshTokenEnc(user.id, null, Date.now());
        summary.usersFailed++;
        log.warn("calendar cron: token revoked — user disconnected", {
          userId: user.id,
        });
        continue;
      }
      if (minted === null) {
        summary.usersFailed++;
        continue;
      }
      const result = await syncUserGigs(
        env.DB,
        user.id,
        deps.makeClient(minted.accessToken),
        Date.now(),
      );
      summary.usersSynced++;
      if (result.created + result.updated + result.deleted > 0) {
        log.info("calendar cron synced", { userId: user.id, ...result });
      }
    } catch (e) {
      summary.usersFailed++;
      log.warn("calendar cron: user sync crashed", {
        userId: user.id,
        error: String(e),
      });
    }
  }
  return summary;
}
