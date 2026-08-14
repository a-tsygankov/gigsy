import type { HelpScenario, HelpVariant } from "../types.ts";

/**
 * The first non-executable scenario. Installing Gigsy happens entirely in
 * browser and OS chrome that Playwright cannot drive and Driver.js cannot
 * highlight, so there is no tour here — only instructions, picked by
 * platform.
 *
 * This is also the prerequisite for `configure-notifications`: iOS Safari
 * exposes the Push API only to a PWA already on the home screen
 * (push.ts's `pushAvailability`), and Settings.tsx's own
 * `UNAVAILABLE_COPY["not-installed"]` already tells people exactly that.
 * The iOS variant below says the same thing, in the same terms, so
 * nobody reads two different explanations of the same requirement.
 */

const iosSafari: HelpVariant = {
  environment: "ios-safari",
  label: "iPhone or iPad (Safari)",
  steps: [
    {
      action: "external",
      externalType: "os-ui",
      title: "Open the Share sheet",
      description:
        "In Safari, tap the Share icon — the square with an arrow pointing up — in the toolbar.",
    },
    {
      action: "external",
      externalType: "os-ui",
      title: "Add to Home Screen",
      description:
        'Scroll down in the Share sheet, tap "Add to Home Screen", then tap "Add" to confirm.',
    },
    {
      action: "external",
      externalType: "os-ui",
      title: "Open Gigsy from the home screen",
      description:
        "Launch Gigsy from the new icon, not from Safari. Notifications only ever reach that installed copy — Safari itself can't deliver them, before or after this step.",
    },
  ],
};

const androidChrome: HelpVariant = {
  environment: "android-chrome",
  label: "Android (Chrome)",
  steps: [
    {
      action: "external",
      externalType: "browser-ui",
      title: "Open Chrome's menu",
      description: "Tap the three dots in the top-right corner of Chrome.",
    },
    {
      action: "external",
      externalType: "browser-ui",
      title: "Install the app",
      description:
        'Tap "Install app" (some versions say "Add to Home screen"), then confirm. Gigsy then opens like any other app, from your home screen or app drawer.',
    },
  ],
};

const desktopChrome: HelpVariant = {
  environment: "desktop-chrome",
  label: "Desktop (Chrome)",
  steps: [
    {
      action: "external",
      externalType: "browser-ui",
      title: "Use the install icon",
      description:
        'Click the install icon at the right edge of the address bar — a small monitor with a down arrow. Don\'t see it? Open the ⋮ menu and choose "Install Gigsy…" instead.',
    },
    {
      action: "external",
      externalType: "browser-ui",
      title: "Confirm",
      description:
        'Click "Install" in the dialog that appears. Gigsy then opens in its own window, separate from your browser tabs.',
    },
  ],
};

const desktopEdge: HelpVariant = {
  environment: "desktop-edge",
  label: "Desktop (Edge)",
  steps: [
    {
      action: "external",
      externalType: "browser-ui",
      title: "Use the install icon",
      description:
        'Click the app-available icon at the right edge of the address bar — a small screen with a plus. Don\'t see it? Open the ⋯ menu, choose "Apps", then "Install this site as an app".',
    },
    {
      action: "external",
      externalType: "browser-ui",
      title: "Confirm",
      description:
        'Click "Install" in the dialog that appears. Gigsy then opens in its own window, separate from your browser tabs.',
    },
  ],
};

/** A wrong (or absent) guess must still leave someone with something they
 *  can do right now — never a shrug. Gigsy works fully in an ordinary
 *  browser tab; the one thing that needs installing is push notifications
 *  (see `configure-notifications`'s own `push-blocked` branch). */
const fallback: HelpVariant = {
  environment: "fallback",
  label: "Another browser",
  steps: [
    {
      action: "external",
      externalType: "browser-ui",
      title: "Look for an install option",
      description:
        'Most current browsers can add Gigsy to your device: check the browser\'s menu for "Install app" or "Add to Home screen", or look for an install icon near the address bar.',
    },
    {
      action: "external",
      externalType: "browser-ui",
      title: "No install option? Gigsy still works",
      description:
        "Bookmark this page and keep using Gigsy in the tab — everything works except push notifications, which only reach an installed copy.",
    },
  ],
};

export const installApp: HelpScenario = {
  id: "install-gigsy",
  title: "Install Gigsy",
  description:
    "Add Gigsy to your home screen or desktop so it opens like an app, and so notifications can reach you.",
  category: "installation",
  executable: false,
  steps: [],
  variants: [iosSafari, androidChrome, desktopChrome, desktopEdge, fallback],
};
