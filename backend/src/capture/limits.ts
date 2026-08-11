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
 * A generous ceiling for a forwarded booking email, and far below
 * Cloudflare's own inbound limit. Its job is to stop someone pasting a
 * novel — or an attachment-laden thread — into an extraction call.
 */
export const MAX_EMAIL_BYTES = 256 * 1024;

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
