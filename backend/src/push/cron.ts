/**
 * The scheduled nudge pass (Phase 10). Runs alongside the calendar
 * sync on the same 15-minute trigger.
 *
 * Per user: work out whether anything deserves saying, decide whether
 * to say it (anti-nagging rules in nudges.ts), then deliver to every
 * device they have. A user is marked as notified when at least one
 * device accepted — marking on a total failure would silence tomorrow's
 * attempt too.
 */
import type { Bindings } from "../env.ts";
import { UsersRepo } from "../repos/users.ts";
import { PushSubscriptionsRepo } from "../repos/push-subscriptions.ts";
import { selectNudge, shouldSend, DEFAULT_THRESHOLDS } from "./nudges.ts";
import { sendPush, type PushResult, type PushTarget } from "./sender.ts";
import { log } from "../logger.ts";

export interface PushCronDeps {
  send: (
    target: PushTarget,
    payload: string,
    options: { vapid: { publicKey: string; privateKey: string }; subject: string },
  ) => Promise<PushResult>;
}

const defaultDeps: PushCronDeps = { send: sendPush };

export interface PushCronSummary {
  notified: number;
  pruned: number;
  skipped: number;
}

export async function runPushCron(
  env: Bindings,
  now = Date.now(),
  deps: PushCronDeps = defaultDeps,
): Promise<PushCronSummary> {
  const summary: PushCronSummary = { notified: 0, pruned: 0, skipped: 0 };

  const publicKey = env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY ?? "";
  // Without both halves there is nothing to sign with; say so once
  // rather than failing per user.
  if (publicKey === "" || privateKey === "") {
    log.info("push cron: VAPID keys not configured — skipping");
    return summary;
  }

  const usersRepo = UsersRepo.for(env.DB);
  const subsRepo = PushSubscriptionsRepo.for(env.DB);
  const subject = env.PUSH_SUBJECT ?? "mailto:noreply@gigsy.app";

  // Only subscribed users can be reached, so start from them rather
  // than scanning everyone.
  for (const userId of await subsRepo.listSubscribedUserIds()) {
    try {
      const user = await usersRepo.get(userId);
      if (user === null) continue;
      const subscriptions = await subsRepo.list(user.id);
      if (subscriptions.length === 0) continue;

      const nudge = await selectNudge(env.DB, user.id, now, DEFAULT_THRESHOLDS);
      if (nudge === null) continue;

      if (!shouldSend(nudge, user.lastPushKey, user.lastPushAt, now)) {
        summary.skipped++;
        continue;
      }

      const payload = JSON.stringify({
        title: nudge.title,
        body: nudge.body,
        path: nudge.path,
      });

      let delivered = false;
      for (const subscription of subscriptions) {
        const result = await deps.send(
          {
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
          payload,
          { vapid: { publicKey, privateKey }, subject },
        );
        if (result === "sent") delivered = true;
        if (result === "gone") {
          await subsRepo.removeByEndpoint(subscription.endpoint);
          summary.pruned++;
        }
      }

      // Only record the nudge if it actually reached a device —
      // otherwise the anti-repeat rule would suppress tomorrow's try.
      if (delivered) {
        await usersRepo.setLastPush(user.id, nudge.key, now);
        summary.notified++;
      }
    } catch (e) {
      // One user's failure never stops the rest, same as the calendar.
      log.warn("push cron: user pass crashed", { userId, error: String(e) });
    }
  }

  return summary;
}
