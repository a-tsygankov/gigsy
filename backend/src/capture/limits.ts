/**
 * What bounds the cost of capture.
 *
 * Both entry points spend the same budget — your AI provider key — so
 * both consult the same rule. The photo route enforced a daily cap
 * inline and the email handler had none at all, which was survivable
 * only while no address was reachable from the internet. Once Email
 * Routing points at the Worker, anyone who learns an address can spend
 * that budget, and the address is unguessable rather than secret.
 */
import type { Bindings } from "../env.ts";
import { DraftsRepo } from "../repos/drafts.ts";

/** Captures per user per UTC day when AI_DAILY_CAP is unset. */
export const DEFAULT_DAILY_CAP = 50;

/**
 * The largest message we will accept at all.
 *
 * This bounds R2 storage and parse cost — nothing more. It used to do a
 * second job as well, capping what reached the model, which only worked
 * while the handler read plain text and no attachment could ever fit. A
 * single phone photo is past 256KB, so that ceiling rejected exactly
 * the mail this feature is for. What we pay a model to read is now
 * bounded separately: MAX_EXTRACT_TEXT_CHARS below, and the
 * per-attachment and count caps in attachments.ts.
 */
export const MAX_EMAIL_BYTES = 3 * 1024 * 1024;

/**
 * The most body text sent for extraction. A forwarded thread can be
 * enormous and the booking is always near the top.
 */
export const MAX_EXTRACT_TEXT_CHARS = 12_000;

export function startOfUtcDayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function dailyCapFrom(env: Pick<Bindings, "AI_DAILY_CAP">): number {
  const parsed = Number(env.AI_DAILY_CAP ?? "");
  // A missing, blank or nonsense value falls back rather than becoming
  // NaN — and NaN compares false against everything, which would
  // silently disable the cap entirely.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

/**
 * Whether this user has capture budget left today.
 *
 * Counts drafts rather than extraction calls: a draft is what a
 * capture produces, and counting the thing that persists means a
 * retried request cannot be used to run the number up twice.
 */
export async function hasCaptureBudget(
  env: Bindings,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const used = await DraftsRepo.for(env.DB).countSince(userId, startOfUtcDayMs(now));
  return used < dailyCapFrom(env);
}
