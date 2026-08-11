/// <reference lib="webworker" />
/**
 * The service worker (Phase 10).
 *
 * This file exists because push notifications need a `push` handler,
 * and vite-plugin-pwa's generated worker cannot host custom code. That
 * makes precaching *our* responsibility now — `precacheAndRoute` below
 * is what keeps the installed app opening with no connectivity, which
 * was previously generated for us. Treat it as load-bearing.
 *
 * The payload arrives already decrypted by the browser, so this worker
 * needs no credentials and never talks to the API — the reason Phase 10
 * chose encrypted payloads over a content-free wake-up.
 */
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/**
 * A new worker waits until it is asked.
 *
 * This used to call `skipWaiting()` at install, so a new worker seized
 * control the moment the browser found one — while the open page kept
 * running the OLD JS bundle until a reload. That is worse than it
 * sounds: the new worker serves the new precache to a page that may
 * still request a lazy chunk the new build dropped, which 404s
 * mid-session.
 *
 * Now the page decides, via the update bar, and asks here.
 */
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

// Still immediate once activated: a worker that has taken over should
// control every open page, not only ones opened after it.
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Load-bearing, and easy to miss: precacheAndRoute serves cached
// ASSETS, but a client-routed URL like /gigs or /login is not one of
// them. Without this fallback the app 404s — or offline, fails to
// navigate at all — on every route except "/". generateSW used to add
// it for us; owning the worker means owning this too.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

interface NudgePayload {
  title: string;
  body: string;
  path: string;
}

self.addEventListener("push", (event) => {
  // A push with no readable payload still deserves to say something —
  // silence would look like a bug on the user's phone.
  let payload: NudgePayload = {
    title: "Gigsy",
    body: "Something needs your attention.",
    path: "/",
  };
  try {
    const data = event.data?.json() as Partial<NudgePayload> | undefined;
    if (data?.title !== undefined && data.body !== undefined) {
      payload = { ...payload, ...(data as NudgePayload) };
    }
  } catch {
    // Keep the generic message.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // Collapse repeats: a second nudge replaces the first rather
      // than stacking, so the tray never becomes a list of chores.
      tag: "gigsy-nudge",
      data: { path: payload.path },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path =
    (event.notification.data as { path?: string } | undefined)?.path ?? "/";

  event.waitUntil(
    (async () => {
      const targetUrl = new URL(path, self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Reuse an open window when there is one — launching a second
      // copy of an installed PWA is disorienting.
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(targetUrl);
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
