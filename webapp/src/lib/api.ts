/**
 * HTTP layer. Two clients with distinct responsibilities:
 *
 * - ApiClient — entity endpoints. Depends on a TokenSource (the
 *   AuthManager) for bearer tokens; on a 401 it asks for one refresh
 *   and retries once, then declares the session expired.
 * - AuthApiClient — the unauthenticated auth endpoints the
 *   AuthManager itself uses (no TokenSource → no dependency cycle).
 *
 * fetch is injectable everywhere; unit tests never touch the network.
 */
import type { AuthApi, AuthSession, SessionTokens } from "./auth-store.ts";
import type {
  Client,
  ClientInput,
  Expense,
  ExpenseInput,
  Gig,
  GigInput,
  ReportSummary,
} from "./types.ts";

export interface TokenSource {
  getAccessToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  onSessionExpired(): void;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly tokens: TokenSource,
    fetchFn?: typeof fetch,
  ) {
    // Bind the default — calling a bare `fetch` reference through a
    // property invokes it with the class as `this`, which browsers
    // reject with "Illegal invocation" (Node lets it slide, so unit
    // tests can't catch it; the login e2e does).
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn(path, {
      method,
      headers: {
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) {
      if (!retried && (await this.tokens.refresh())) {
        return this.request(method, path, body, true);
      }
      this.tokens.onSessionExpired();
      throw new ApiError(401, "session expired");
    }
    if (!res.ok) {
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── gigs ─────────────────────────────────────────────────────────
  async listGigs(): Promise<Gig[]> {
    return (await this.request<{ items: Gig[] }>("GET", "/api/gigs")).items;
  }
  getGig(id: string): Promise<Gig> {
    return this.request("GET", `/api/gigs/${id}`);
  }
  putGig(id: string, input: GigInput): Promise<Gig> {
    return this.request("PUT", `/api/gigs/${id}`, input);
  }
  deleteGig(id: string): Promise<void> {
    return this.request("DELETE", `/api/gigs/${id}`);
  }

  // ── clients ──────────────────────────────────────────────────────
  async listClients(): Promise<Client[]> {
    return (await this.request<{ items: Client[] }>("GET", "/api/clients")).items;
  }
  getClient(id: string): Promise<Client> {
    return this.request("GET", `/api/clients/${id}`);
  }
  putClient(id: string, input: ClientInput): Promise<Client> {
    return this.request("PUT", `/api/clients/${id}`, input);
  }
  deleteClient(id: string): Promise<void> {
    return this.request("DELETE", `/api/clients/${id}`);
  }

  // ── expenses ─────────────────────────────────────────────────────
  async listExpenses(): Promise<Expense[]> {
    return (await this.request<{ items: Expense[] }>("GET", "/api/expenses"))
      .items;
  }
  getExpense(id: string): Promise<Expense> {
    return this.request("GET", `/api/expenses/${id}`);
  }
  putExpense(id: string, input: ExpenseInput): Promise<Expense> {
    return this.request("PUT", `/api/expenses/${id}`, input);
  }
  deleteExpense(id: string): Promise<void> {
    return this.request("DELETE", `/api/expenses/${id}`);
  }

  // ── reports ──────────────────────────────────────────────────────
  getReportSummary(): Promise<ReportSummary> {
    return this.request("GET", "/api/reports/summary");
  }
}

/** Unauthenticated auth endpoints (used by AuthManager). */
export class AuthApiClient implements AuthApi {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn?: typeof fetch) {
    // Same "Illegal invocation" guard as ApiClient.
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  async getConfig(): Promise<{ googleClientId: string }> {
    const res = await this.fetchFn("/api/auth/config");
    if (!res.ok) throw new ApiError(res.status, "config unavailable");
    return (await res.json()) as { googleClientId: string };
  }

  async loginWithGoogle(idToken: string): Promise<AuthSession> {
    const res = await this.fetchFn("/api/auth/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new ApiError(res.status, "sign-in failed");
    return (await res.json()) as AuthSession;
  }

  async refreshSession(refreshToken: string): Promise<SessionTokens | null> {
    const res = await this.fetchFn("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionTokens;
  }
}
