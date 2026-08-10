/**
 * Session state (docs/plan.md §6): the access token lives in memory
 * only; the rotating refresh token (and the user snapshot) persist in
 * IndexedDB via an injectable KV — cookies are unreliable in iOS
 * PWAs, and tests inject an in-memory KV.
 *
 * AuthManager also implements the ApiClient's TokenSource: it hands
 * out the in-memory token while fresh (14 min — one minute inside the
 * server's 15-min JWT TTL) and transparently rotates after that.
 */
import type { SessionUser } from "./types.ts";

export interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthSession extends SessionTokens {
  user: SessionUser;
}

/**
 * A refresh has three outcomes, and conflating them is what turned a
 * flaky network into a sign-out: only the server actually rejecting
 * the token means the session is dead. Anything else — offline, DNS
 * failure, timeout, a 5xx from the worker — says nothing about the
 * token and must leave it alone.
 */
export type RefreshResult =
  | { ok: true; tokens: SessionTokens; user?: SessionUser }
  | { ok: false; reason: "rejected" | "unreachable" };

export interface AuthApi {
  loginWithGoogle(idToken: string): Promise<AuthSession>;
  refreshSession(refreshToken: string): Promise<RefreshResult>;
}

/** What bootstrap() managed to restore. */
export type BootstrapOutcome = "live" | "offline" | "signed-out";

const REFRESH_KEY = "gigsy.refreshToken";
const USER_KEY = "gigsy.user";
const TOKEN_FRESH_MS = 14 * 60 * 1000;

export class AuthManager {
  private accessToken: string | null = null;
  private tokenIssuedAt = 0;
  private user: SessionUser | null = null;
  private listeners = new Set<() => void>();
  private inFlightRefresh: Promise<"ok" | "rejected" | "unreachable"> | null = null;

  constructor(
    private readonly api: AuthApi,
    private readonly storage: KVStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Signed in means "we know who you are", not "we hold a live
   * access token" — the ledger is local, so a known user stays in the
   * app while offline and the token is re-minted when the network
   * returns. */
  isSignedIn(): boolean {
    return this.user !== null;
  }

  /** True when we also hold a usable access token (server calls will
   * carry auth). False during an offline restore. */
  hasLiveToken(): boolean {
    return this.accessToken !== null;
  }

  getUser(): SessionUser | null {
    return this.user;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async setSession(
    tokens: SessionTokens,
    user: SessionUser | null,
  ): Promise<void> {
    this.accessToken = tokens.accessToken;
    this.tokenIssuedAt = this.clock();
    if (user !== null) {
      this.user = user;
      await this.storage.set(USER_KEY, JSON.stringify(user));
    }
    await this.storage.set(REFRESH_KEY, tokens.refreshToken);
    this.notify();
  }

  private async clearSession(): Promise<void> {
    this.accessToken = null;
    this.tokenIssuedAt = 0;
    this.user = null;
    await this.storage.del(REFRESH_KEY);
    await this.storage.del(USER_KEY);
    this.notify();
  }

  async signIn(googleIdToken: string): Promise<void> {
    const session = await this.api.loginWithGoogle(googleIdToken);
    await this.setSession(session, session.user);
  }

  /** Install a session obtained outside the Google flow (the
   * non-production test-login) — identical persistence semantics. */
  async adoptSession(session: AuthSession): Promise<void> {
    await this.setSession(session, session.user);
  }

  /** App start: resurrect the session from the persisted refresh
   * token. A token the server rejects (rotated elsewhere / expired)
   * wipes local state and the user sees the login screen — but an
   * unreachable server does not, because the app's data is local and
   * must open offline. */
  async bootstrap(): Promise<BootstrapOutcome> {
    const stored = await this.storage.get(REFRESH_KEY);
    if (stored === null) return "signed-out";

    // Restore the cached identity BEFORE touching the network, so a
    // slow or dead connection can't hold the whole app hostage.
    const cached = JSON.parse(
      (await this.storage.get(USER_KEY)) ?? "null",
    ) as SessionUser | null;
    if (cached !== null && this.user === null) {
      this.user = cached;
      this.notify();
    }

    const outcome = await this.refreshOnce();
    if (outcome === "ok") return "live";
    if (outcome === "rejected") return "signed-out";
    // Unreachable: keep the token and the identity. ApiClient will
    // retry on the next call, and the sync engine retries on reconnect.
    return cached === null ? "signed-out" : "offline";
  }

  async signOut(): Promise<void> {
    await this.clearSession();
  }

  // ── TokenSource (consumed by ApiClient) ─────────────────────────
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken === null) return null;
    if (this.clock() - this.tokenIssuedAt < TOKEN_FRESH_MS) {
      return this.accessToken;
    }
    return (await this.refresh()) ? this.accessToken : null;
  }

  async refresh(): Promise<boolean> {
    return (await this.refreshOnce()) === "ok";
  }

  /**
   * Refreshes are single-flighted, and that is a correctness
   * requirement rather than an optimisation: refresh tokens rotate and
   * are consumed on use, so two concurrent attempts spend the same
   * one-shot token and the loser gets a 401 — indistinguishable from a
   * genuinely dead session, which would sign the user out.
   *
   * Startup makes this easy to hit: the app restores its identity from
   * cache and starts the sync engine, whose first request 401s (no
   * access token yet) and triggers a refresh at the same moment
   * bootstrap is running its own.
   */
  private refreshOnce(): Promise<"ok" | "rejected" | "unreachable"> {
    this.inFlightRefresh ??= this.runRefresh().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async runRefresh(): Promise<"ok" | "rejected" | "unreachable"> {
    const stored = await this.storage.get(REFRESH_KEY);
    // Nothing to refresh with: the session is over, not merely stale.
    if (stored === null) {
      await this.clearSession();
      return "rejected";
    }
    const result = await this.api.refreshSession(stored);
    if (result.ok) {
      await this.setSession(result.tokens, result.user ?? null);
      return "ok";
    }
    // Only a rejection ends the session; an unreachable server leaves
    // it intact so the next attempt can recover it.
    if (result.reason === "rejected") await this.clearSession();
    return result.reason;
  }
}
