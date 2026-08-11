import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // "prompt", not "autoUpdate": the app offers an update bar rather
      // than reloading under someone. Gig and expense forms hold their
      // state in React until Save, so a silent reload loses what is
      // being typed — which gets reported as "the app lost my data".
      registerType: "prompt",
      // Registration moves into src/lib/pwa-update-browser.ts, which
      // also needs the registration object to poll for updates on
      // focus. The generated script only registers and then forgets.
      injectRegister: null,
      // injectManifest, not generateSW: the worker hosts a `push`
      // handler (Phase 10), which generated workers cannot. The cost
      // is that precaching becomes src/sw.ts's job — that file is what
      // keeps the installed app opening offline.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
      },
      // The service worker precaches the app shell so the PWA loads
      // with zero connectivity (docs/plan.md §7). Icons come from
      // scripts/generate-icons.mjs (committed output — rerun after
      // changing the mark).
      includeAssets: [
        "icons/apple-touch-icon.png",
        "icons/favicon-32.png",
        "icons/favicon-16.png",
      ],
      manifest: {
        name: "Gigsy",
        short_name: "Gigsy",
        description: "Personal gig-work tracker",
        // Match index.html's <meta name="theme-color"> — mismatched
        // values cause a flash of the wrong colour during PWA launch.
        theme_color: "#f8fafc",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        scope: "/",
        // "any" + "maskable" kept separate: Android picks maskable
        // for adaptive icons; iOS uses the apple-touch-icon link.
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  // `vite preview` serves the built app WITH the real service worker,
  // which is the only way to exercise offline reopen — dev has no
  // worker at all. It needs the same /api proxy as dev.
  preview: {
    proxy: {
      "/api": {
        target: process.env["VITE_WORKER_ORIGIN"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        // Mirrors the Pages Functions proxy in production. Set
        // VITE_WORKER_ORIGIN if your `wrangler dev` lives elsewhere.
        target: process.env["VITE_WORKER_ORIGIN"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
