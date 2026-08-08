// Pages Functions middleware — runs on every request to the Pages
// project (including the static SPA HTML and the /api/* proxy).
// Security headers for the SPA.
//
// CSP notes:
//   - script-src/connect-src/frame-src allow accounts.google.com from
//     day one — Google Identity Services (Phase 2 auth: sign-in script,
//     button iframe, token endpoints) works without a follow-up CSP
//     change.
//   - style-src 'unsafe-inline' — Tailwind emits static CSS, but GIS
//     injects inline styles for its button; revisit after Phase 2.
//   - connect-src 'self' — /api/* is proxied through Pages Functions
//     so it's same-origin from the browser's view.
//   - img-src data:/blob: — receipt-photo previews before upload.
//   - frame-ancestors 'none' — no embedding.

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const onRequest: PagesFunction = async ({ next }) => {
  const res = await next();
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Camera: in-app receipt/flyer photo capture (Phase 5).
  headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};
