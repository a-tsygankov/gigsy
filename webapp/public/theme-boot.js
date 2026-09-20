// Applied before first paint: the stored theme onto <html data-theme>
// and the browser-chrome colour onto <meta name="theme-color">.
//
// An EXTERNAL classic script, not inline, and the reason is the
// production Content-Security-Policy (functions/_middleware.ts):
// `script-src 'self'` with no 'unsafe-inline' and no hash. The inline
// version this replaced was silently blocked on every cold start of the
// deployed app — so the theme reverted to light until Settings was
// opened, and iOS painted a light status bar over a dark app — while
// `vite dev`, which serves no CSP, showed it working. A file under
// public/ is same-origin, so 'self' admits it; a plain <script src> in
// <head> blocks parsing, so it still runs before anything is painted.
//
// Kept minimal and duplicated from src/lib/theme.ts on purpose:
// importing a module here would defeat the point by making it async.
// src/lib/theme-boot.test.ts runs THIS file against the same cases
// theme.test.ts pins for the module, so the two cannot drift silently.
// main.tsx applies the stored theme again once the app loads, as a
// fallback for the day this file fails to run at all.
(function () {
  try {
    var stored = localStorage.getItem("gigsy:theme");
    var choice =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    var dark =
      choice === "dark" ||
      (choice === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    // A fresh tag rather than an edited one, as src/lib/theme.ts does:
    // the installed iOS app has been seen to keep the colour it read
    // at launch across an in-place edit, and a new node is the change
    // it notices. Guarded, so a page without replaceWith still gets
    // the edit.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var colour = dark ? "#0f172a" : "#f8fafc";
      if (meta.replaceWith) {
        var fresh = document.createElement("meta");
        fresh.setAttribute("name", "theme-color");
        fresh.setAttribute("content", colour);
        meta.replaceWith(fresh);
      } else {
        meta.setAttribute("content", colour);
      }
    }
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
