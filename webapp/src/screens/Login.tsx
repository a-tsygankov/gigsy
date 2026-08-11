import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthState, useServices } from "../lib/app-context.tsx";
import { renderGoogleButton } from "../lib/google-signin.ts";
import { appLog } from "../lib/logger.ts";
import { useConsoleTap } from "../components/ConsoleProvider.tsx";

export function Login() {
  const { authApi, auth } = useServices();
  const { ready, signedIn } = useAuthState();
  const navigate = useNavigate();
  const tap = useConsoleTap();
  const buttonHost = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => authApi.getConfig(),
  });

  useEffect(() => {
    if (signedIn) navigate("/", { replace: true });
  }, [signedIn, navigate]);

  const clientId = config.data?.googleClientId ?? "";

  useEffect(() => {
    if (clientId === "" || buttonHost.current === null) return;
    renderGoogleButton(buttonHost.current, clientId, (idToken) => {
      void auth.signIn(idToken).catch((e: unknown) => {
        appLog.error("sign-in failed", { error: String(e) });
        setError("Sign-in failed — please try again.");
      });
    }).catch(() => setError("Couldn't load Google Sign-In."));
  }, [clientId, auth]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-6 text-slate-900">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1
          onClick={tap}
          className="select-none text-3xl font-bold tracking-tight"
        >
          Gigsy
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Your gigs, clients, and expenses — tracked in one place, built
          for one-off work across many agencies.
        </p>

        <div className="mt-8 min-h-[44px]" data-testid="login-actions">
          {config.isPending && !ready ? null : null}
          {config.isError && (
            <p className="text-sm text-amber-700">
              Can't reach the server — check your connection and reload.
            </p>
          )}
          {config.isSuccess && clientId === "" && (
            <p
              className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
              data-testid="login-unconfigured"
            >
              Google sign-in isn't configured yet — set{" "}
              <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> in
              the worker's vars and redeploy.
            </p>
          )}
          <div ref={buttonHost} data-testid="google-button-host" />
          {config.data?.testAuthEnabled === true && (
            // Google-free sign-in — the backend only serves this
            // outside production, so the button can never ship there.
            <button
              type="button"
              data-testid="test-signin"
              onClick={() => {
                void authApi
                  .testLogin("dev@test.local")
                  .then((session) => auth.adoptSession(session))
                  .catch(() => setError("Test sign-in failed."));
              }}
              className="mt-3 w-full rounded-xl border border-dashed border-slate-300 px-4 py-2
                         text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              Dev sign-in (no Google)
            </button>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>

        {config.data?.inviteOnly === true && (
          // Without this, a refused sign-in is an unexplained failure —
          // and "it's broken" is the wrong conclusion to leave someone
          // with when the truth is "you weren't invited yet".
          <p className="mt-4 text-xs text-slate-500" data-testid="login-invite-only">
            This deployment is invite-only. If your Google account hasn't been
            added, sign-in will be refused — ask whoever sent you here.
          </p>
        )}

        {/* Google's OAuth verification requires the policy to be linked
            from the page a reviewer lands on. */}
        <p className="mt-6 text-xs text-slate-400">
          <Link to="/privacy" className="underline" data-testid="login-privacy-link">
            Privacy policy
          </Link>
        </p>
      </div>
    </main>
  );
}
