import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
