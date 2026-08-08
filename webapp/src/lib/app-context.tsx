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
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import { SyncEngine, type SyncState } from "./sync-engine.ts";
import { OfflineDataService } from "./data-service.ts";
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

interface UserDataStack {
  data: OfflineDataService;
  engine: SyncEngine;
}

const AppContext = createContext<
  (AppServices & { ready: boolean; stack: UserDataStack | null }) | null
>(null);

export function AppProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [stack, setStack] = useState<UserDataStack | null>(null);

  useEffect(() => {
    void services.auth.bootstrap().finally(() => setReady(true));
  }, [services]);

  // The offline stack is per-user (per-user Dexie DB — shared-device
  // isolation). Built on sign-in, torn down on sign-out.
  const userId = useSyncExternalStore(
    (cb) => services.auth.subscribe(cb),
    () => services.auth.getUser()?.id ?? null,
  );

  useEffect(() => {
    if (userId === null) {
      setStack(null);
      return;
    }
    const store = new LocalStore(openUserDb(userId));
    const engine = new SyncEngine(store, services.api);
    const data = new OfflineDataService(store, engine, services.api);
    engine.start();
    setStack({ data, engine });
    return () => engine.stop();
  }, [userId, services]);

  const value = useMemo(
    () => ({ ...services, ready, stack }),
    [services, ready, stack],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Entity data access for signed-in screens (local-first). */
export function useData(): OfflineDataService {
  const ctx = useContext(AppContext);
  if (ctx?.stack == null) throw new Error("useData before sign-in");
  return ctx.stack.data;
}

/** Sync engine state for indicators (null while signed out). */
export function useSyncState(): SyncState | null {
  const ctx = useContext(AppContext);
  const engine = ctx?.stack?.engine ?? null;
  return useSyncExternalStore(
    (cb) => engine?.subscribe(cb) ?? (() => undefined),
    () => engine?.getState() ?? null,
  );
}

/** True once the signed-in user's offline stack is constructed. */
export function useDataReady(): boolean {
  const ctx = useContext(AppContext);
  return ctx?.stack != null;
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
