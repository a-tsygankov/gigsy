import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { AppProvider, createAppServices } from "./lib/app-context.tsx";
import { appLog, installGlobalErrorCapture } from "./lib/logger.ts";
import { CLIENT_VERSION } from "./lib/versions.ts";
import { startUpdateWatch } from "./lib/pwa-update-browser.ts";
import { bootTheme, followSystemTheme } from "./lib/theme.ts";
import "./styles.css";

// Route uncaught errors into the hidden console's client-log feed —
// on a phone there are no devtools to see them otherwise.
installGlobalErrorCapture(appLog, window);
appLog.info("app started", { version: CLIENT_VERSION });

// The theme, again. public/theme-boot.js already applied it before
// first paint; this is the in-bundle fallback for when that file does
// not run (its inline predecessor was CSP-blocked in production for
// months and nothing here caught it), and the app-wide OS follower for
// the "system" choice. See lib/theme.ts.
bootTheme(window, document);
followSystemTheme(window, document);

// Registers the service worker and watches for a newer build.
startUpdateWatch();

const services = createAppServices();
const queryClient = new QueryClient({
  defaultOptions: {
    // networkMode "always": TanStack Query's default pauses queries
    // AND mutations while navigator.onLine is false — but ours are
    // local-first (Dexie) and must run offline; the data layer does
    // its own network handling (docs/plan.md §7).
    queries: { staleTime: 30_000, retry: 1, networkMode: "always" },
    mutations: { networkMode: "always" },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppProvider services={services}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
