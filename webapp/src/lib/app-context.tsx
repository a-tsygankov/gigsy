/**
 * Composition root: wires the real implementations (Dexie KV, fetch)
 * into the tested core (AuthManager, ApiClient) and exposes them via
 * context. Screens depend on the abstractions only.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ApiClient, AuthApiClient } from "./api.ts";
import { AuthManager } from "./auth-store.ts";
import { DexieKV } from "./kv.ts";
import type { SessionUser } from "./types.ts";

export interface AppServices {
  authApi: AuthApiClient;
  auth: AuthManager;
  api: ApiClient;
}

export function createAppServices(): AppServices {
  const authApi = new AuthApiClient();
  const auth = new AuthManager(authApi, new DexieKV());
  const api = new ApiClient(auth);
  return { authApi, auth, api };
}

const AppContext = createContext<(AppServices & { ready: boolean }) | null>(null);

export function AppProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void services.auth.bootstrap().finally(() => setReady(true));
  }, [services]);

  const value = useMemo(() => ({ ...services, ready }), [services, ready]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useServices(): AppServices & { ready: boolean } {
  const ctx = useContext(AppContext);
  if (ctx === null) throw new Error("useServices outside AppProvider");
  return ctx;
}

export function useAuthState(): {
  ready: boolean;
  signedIn: boolean;
  user: SessionUser | null;
} {
  const { auth, ready } = useServices();
  const signedIn = useSyncExternalStore(
    (cb) => auth.subscribe(cb),
    () => auth.isSignedIn(),
  );
  const user = useSyncExternalStore(
    (cb) => auth.subscribe(cb),
    () => auth.getUser(),
  );
  return { ready, signedIn, user };
}
