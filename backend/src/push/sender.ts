/**
 * Delivering one notification to one subscription (RFC 8030).
 *
 * The push service is a dumb relay: it sees an opaque body and knows
 * only where to send it. Everything meaningful is in the encrypted
 * payload (encrypt.ts) and the VAPID signature (vapid.ts).
 *
 * The outcome is three-way on purpose, the same distinction the
 * calendar connection needed: `gone` means this subscription is dead
 * and its row should be removed, while `failed` says nothing about the
 * subscription and simply retries later. Collapsing the two is how a
 * dead endpoint gets retried forever, or a live one gets thrown away
 * over a transient 500.
 */
import { encryptPayload, type SubscriptionKeys } from "./encrypt.ts";
import { vapidAuthorization, type VapidKeys } from "./vapid.ts";

export type PushResult = "sent" | "gone" | "failed";

export interface PushTarget extends SubscriptionKeys {
  endpoint: string;
}

export interface SendOptions {
  vapid: VapidKeys;
  /** Contact for the push service, per RFC 8292 (`mailto:` or https). */
  subject: string;
  /** How long the service may hold an undelivered message. A day: a
   * nudge about an unpaid invoice is still true tomorrow, but a week
   * later it is noise. */
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  now?: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export async function sendPush(
  target: PushTarget,
  payload: string,
  options: SendOptions,
): Promise<PushResult> {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  try {
    const body = await encryptPayload(payload, target);
    const authorization = await vapidAuthorization({
      endpoint: target.endpoint,
      keys: options.vapid,
      subject: options.subject,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const res = await fetchFn(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
        // Nudges are not time-critical; "normal" lets a phone batch
        // them with other wake-ups instead of lighting up the radio.
        Urgency: "normal",
      },
      body,
    });

    // 404: the endpoint never existed. 410: the browser unsubscribed
    // or the service expired it. Either way it will never work again.
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    // Network error, or key material the browser sent that we cannot
    // use — the latter is permanent, but indistinguishable here, and
    // retrying a handful of times costs nothing.
    return "failed";
  }
}
