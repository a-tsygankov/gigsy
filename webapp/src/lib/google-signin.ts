/**
 * Thin Google Identity Services wrapper (browser-only, untestable
 * headlessly — kept free of logic on purpose). Loads the GIS script
 * once and renders the official button; the credential callback hands
 * the ID token to the caller (→ AuthManager.signIn).
 */

interface GisIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
  }): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
}

interface GisCodeClient {
  requestCode(): void;
}

interface GisOauth2Api {
  initCodeClient(config: {
    client_id: string;
    scope: string;
    ux_mode: "popup";
    callback: (response: { code?: string; error?: string }) => void;
  }): GisCodeClient;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GisIdApi; oauth2?: GisOauth2Api } };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Sign-In"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Writing gigs onto a calendar — what connecting asks for. */
export const CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/**
 * Reading when the user is busy (Phase 12).
 *
 * Asked for separately, and never bundled into the connect flow. Phase
 * 6 made the integration one-way on purpose; reading back is a real
 * change in what Gigsy can see, and the plan is explicit that it must
 * be presented as a choice — "let Gigsy see when you are busy, so your
 * availability page is right". A user who declines still gets the
 * page, built on Gigsy bookings alone, and the page says so.
 *
 * `calendar.freebusy`, NOT `calendar.readonly`. The two both permit the
 * one call this app makes — `POST /freeBusy` — but `readonly` grants
 * "see and download any calendar you can access": every event title,
 * description, location and guest list. `freebusy` grants availability
 * and nothing else, which is exactly and only what this feature reads.
 * See `docs/google-oauth-scopes.md` for the four scopes the endpoint
 * accepts and why this is the narrowest.
 *
 * Nobody is signed out by this. Google grants the union of what has
 * been consented to, so an existing grant of `readonly` still permits
 * the call, and `AvailabilitySection` probes with
 * `checkCalendarFreeBusy()` before ever prompting — so a user who
 * already enabled this is never asked again. New consent is the
 * narrower scope.
 */
export const CALENDAR_FREEBUSY_SCOPE =
  "https://www.googleapis.com/auth/calendar.freebusy";

/**
 * Making the dedicated "Gigsy" calendar.
 *
 * `POST /calendars` is permitted by none of the scopes connecting asks
 * for, which is why that feature could not succeed at all: it 403'd,
 * the backend reported `reconnect-required`, and reconnecting asked for
 * `calendar.events` again — so the retry failed identically and the
 * advice sent people in a circle.
 *
 * `calendar.app.created` exists precisely for this — "make secondary
 * Google calendars, and see, create, change and delete events on them"
 * — and is narrower than the alternatives (`calendar`,
 * `calendar.calendars`). It does NOT replace `calendar.events`: that is
 * still what writes gigs onto whichever calendar the user picks, which
 * defaults to `primary` and is not app-created. The dedicated-calendar
 * consent therefore asks for both.
 */
export const CALENDAR_APP_CREATED_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

/** Calendar-scope consent popup (docs/plan.md §9). Resolves with the
 * one-time auth code the backend exchanges for a refresh token.
 *
 * Google grants the union of what has been consented to, so asking for
 * a further scope later keeps the events scope already held. */
export async function requestCalendarCode(
  clientId: string,
  scopes: readonly string[] = [CALENDAR_EVENTS_SCOPE],
): Promise<string> {
  await loadGisScript();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google OAuth unavailable");
  return new Promise<string>((resolve, reject) => {
    oauth2
      .initCodeClient({
        client_id: clientId,
        scope: scopes.join(" "),
        ux_mode: "popup",
        callback: (response) => {
          if (response.code !== undefined) resolve(response.code);
          else reject(new Error(response.error ?? "consent cancelled"));
        },
      })
      .requestCode();
  });
}

export async function renderGoogleButton(
  el: HTMLElement,
  clientId: string,
  onIdToken: (idToken: string) => void,
): Promise<void> {
  await loadGisScript();
  const gis = window.google?.accounts?.id;
  if (!gis) throw new Error("Google Sign-In unavailable");
  gis.initialize({
    client_id: clientId,
    callback: (response) => onIdToken(response.credential),
  });
  gis.renderButton(el, { theme: "outline", size: "large", width: 280 });
}
