import { Navigate, Outlet } from "react-router-dom";
import { useAuthState } from "../lib/app-context.tsx";
import { TabBar } from "./TabBar.tsx";

/** Route layout for everything behind sign-in: waits for the session
 * bootstrap, bounces to /login when signed out, and frames child
 * screens with the bottom tab bar. */
export function AuthGate() {
  const { ready, signedIn } = useAuthState();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-pulse rounded-full bg-emerald-200" aria-label="Loading" />
      </div>
    );
  }
  if (!signedIn) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen bg-slate-50 pb-16 text-slate-900">
      <Outlet />
      <TabBar />
    </div>
  );
}
