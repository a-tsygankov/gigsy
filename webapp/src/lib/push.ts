/**
 * Browser-side push subscription (Phase 10).
 *
 * The browser owns the subscription: it asks its own push service for
 * one, using our VAPID public key, and we only record the result. This
 * module is the awkward-DOM-API half; everything it returns is plain
 * data the data layer can post.
 */

/** Why push can't be offered, in terms the UI can explain. */
export type PushUnavailable =
  | "unsupported" // no service worker or Push API at all
  | "not-installed" // iOS: only an installed PWA gets push
  | "denied" // the user said no, and only they can undo it
  | "not-configured"; // no VAPID key on the server

export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * iOS is the case worth special-handling: Safari exposes the Push API
 * only to a PWA installed to the home screen, so a browser-tab user
 * sees the button, taps it, and nothing happens. Detecting it lets the
 * UI say "add Gigsy to your home screen first" instead.
 */
export function pushAvailability(): PushUnavailable | "available" {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // On iOS the APIs are genuinely absent until installed, so the
    // distinction is worth drawing for the message shown.
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    return isIos && !standalone ? "not-installed" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  return "available";
}

/** Built on an explicit ArrayBuffer: `applicationServerKey` wants a
 * BufferSource, and Uint8Array.from produces an ArrayBufferLike view
 * that TypeScript won't accept (it could be a SharedArrayBuffer). */
function urlBase64ToBuffer(base64: string): BufferSource {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return view;
}

function keyToBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) return "";
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toData(subscription: PushSubscription): PushSubscriptionData {
  return {
    endpoint: subscription.endpoint,
    p256dh: keyToBase64Url(subscription.getKey("p256dh")),
    auth: keyToBase64Url(subscription.getKey("auth")),
  };
}

/** The existing subscription for this browser, if it already has one. */
export async function currentSubscription(): Promise<PushSubscriptionData | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing === null ? null : toData(existing);
}

/**
 * Asks the browser to subscribe. The permission prompt only appears in
 * response to a user gesture, so this must be called from a click —
 * calling it on mount silently fails on some browsers and permanently
 * annoys users on the rest.
 */
export async function subscribe(
  vapidPublicKey: string,
): Promise<PushSubscriptionData> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    // Required: a push that can't show a notification is not allowed.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
  });
  return toData(subscription);
}

/** Unsubscribes locally. The caller still tells the server, because a
 * subscription the browser has forgotten would otherwise be pushed to
 * until the service rejects it. */
export async function unsubscribe(): Promise<string | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) return null;
  const { endpoint } = existing;
  await existing.unsubscribe();
  return endpoint;
}
