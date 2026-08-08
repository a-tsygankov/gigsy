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

export interface AuthApi {
  loginWithGoogle(idToken: string): Promise<AuthSession>;
  refreshSession(
    refreshToken: string,
  ): Promise<(SessionTokens & { user?: SessionUser }) | null>;
}

const REFRESH_KEY = "gigsy.refreshToken";
const USER_KEY = "gigsy.user";
const TOKEN_FRESH_MS = 14 * 60 * 1000;

export class AuthManager {
  private accessToken: string | null = null;
  private tokenIssuedAt = 0;
  private user: SessionUser | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: AuthApi,
    private readonly storage: KVStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  isSignedIn(): boolean {
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

  /** App start: resurrect the session from the persisted refresh
   * token. A rejected token (rotated elsewhere / expired) wipes
   * local state — the user just sees the login screen. */
  async bootstrap(): Promise<void> {
    const stored = await this.storage.get(REFRESH_KEY);
    if (stored === null) return;
    const session = await this.api.refreshSession(stored);
    if (session === null) {
      await this.clearSession();
      return;
    }
    const user =
      session.user ??
      (JSON.parse((await this.storage.get(USER_KEY)) ?? "null") as SessionUser | null);
    await this.setSession(session, user);
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
    const stored = await this.storage.get(REFRESH_KEY);
    if (stored === null) return false;
    const session = await this.api.refreshSession(stored);
    if (session === null) {
      await this.clearSession();
      return false;
    }
    await this.setSession(session, session.user ?? null);
    return true;
  }

  onSessionExpired = (): void => {
    void this.clearSession();
  };
}
