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

declare global {
  interface Window {
    google?: { accounts?: { id?: GisIdApi } };
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
