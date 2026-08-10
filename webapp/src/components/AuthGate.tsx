import { useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuthState, useDataReady } from "../lib/app-context.tsx";
import { TabBar } from "./TabBar.tsx";
import { Splash } from "./Splash.tsx";

/** Route layout for everything behind sign-in: waits for the session
 * bootstrap AND the per-user offline stack, bounces to /login when
 * signed out, and frames child screens with the bottom tab bar.
 *
 * The wait is bounded by the refresh timeout in AuthApiClient, but the
 * splash also offers a manual escape — a user staring at a startup
 * screen should always have a way forward. */
export function AuthGate() {
  const { ready, signedIn } = useAuthState();
  const dataReady = useDataReady();
  const [skipped, setSkipped] = useState(false);

  const waiting = !skipped && (!ready || (signedIn && !dataReady));
  if (waiting) {
    return (
      <Splash
        // Skipping is only meaningful once we know who the user is —
        // their data is local, so the app works without the server.
        onSkip={signedIn && dataReady ? () => setSkipped(true) : undefined}
        skipLabel="Continue offline"
      />
    );
  }
  if (!signedIn) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-dvh bg-slate-50 pb-[calc(4rem+env(safe-area-inset-bottom))] text-slate-900">
      <Outlet />
      <TabBar />
    </div>
  );
}
