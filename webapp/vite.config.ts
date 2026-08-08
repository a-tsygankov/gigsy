import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // The service worker precaches the app shell so the PWA loads
      // with zero connectivity (docs/plan.md §7). Icons land with the
      // Phase 3 design pass — the manifest ships without them until
      // then, so installability is limited but the offline shell
      // already works.
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
        icons: [],
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
