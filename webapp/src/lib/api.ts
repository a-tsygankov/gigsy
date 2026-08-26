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
import type { Settings, SettingsPatch } from "./settings-schema.ts";
import type {
  AuthApi,
  AuthSession,
  RefreshResult,
  SessionTokens,
} from "./auth-store.ts";

/** Startup must never wait longer than this for a session refresh. */
const REFRESH_TIMEOUT_MS = 8_000;
import type {
  Allocation,
  AllocationInput,
  Client,
  ClientInput,
  DashboardSummary,
  Draft,
  Expense,
  ExpenseInput,
  Gig,
  GigInput,
  Payment,
  PaymentInput,
  ReportFilters,
  ReportSummary,
  Service,
  ServiceInput,
} from "./types.ts";

export interface TokenSource {
  getAccessToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
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
      // Deliberately does NOT end the session. A refresh can fail
      // because the token is dead OR because the network is — only the
      // token source can tell, and it clears itself in the first case.
      // Signing out here would log the user out of an offline app.
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

  // ── services ─────────────────────────────────────────────────────
  async listServices(): Promise<Service[]> {
    return (await this.request<{ items: Service[] }>("GET", "/api/services")).items;
  }
  getService(id: string): Promise<Service> {
    return this.request("GET", `/api/services/${id}`);
  }
  putService(id: string, input: ServiceInput): Promise<Service> {
    return this.request("PUT", `/api/services/${id}`, input);
  }
  deleteService(id: string): Promise<void> {
    return this.request("DELETE", `/api/services/${id}`);
  }

  // ── payments ─────────────────────────────────────────────────────
  async listPayments(): Promise<Payment[]> {
    return (await this.request<{ items: Payment[] }>("GET", "/api/payments")).items;
  }
  getPayment(id: string): Promise<Payment> {
    return this.request("GET", `/api/payments/${id}`);
  }
  putPayment(id: string, input: PaymentInput): Promise<Payment> {
    return this.request("PUT", `/api/payments/${id}`, input);
  }
  deletePayment(id: string): Promise<void> {
    return this.request("DELETE", `/api/payments/${id}`);
  }

  // ── allocations (which gigs a payment paid for) ──────────────────
  /** Unfiltered by default — the pull needs every row to spot the ones
   *  deleted elsewhere. `paymentId`/`gigId` narrow it for screens. */
  async listAllocations(
    filter: { paymentId?: string; gigId?: string } = {},
  ): Promise<Allocation[]> {
    const params = new URLSearchParams();
    if (filter.paymentId !== undefined) params.set("paymentId", filter.paymentId);
    if (filter.gigId !== undefined) params.set("gigId", filter.gigId);
    const qs = params.toString();
    return (
      await this.request<{ items: Allocation[] }>(
        "GET",
        `/api/allocations${qs ? `?${qs}` : ""}`,
      )
    ).items;
  }
  getAllocation(id: string): Promise<Allocation> {
    return this.request("GET", `/api/allocations/${id}`);
  }
  putAllocation(id: string, input: AllocationInput): Promise<Allocation> {
    return this.request("PUT", `/api/allocations/${id}`, input);
  }
  deleteAllocation(id: string): Promise<void> {
    return this.request("DELETE", `/api/allocations/${id}`);
  }

  /** Online-only: upload the proof photo/mail for a payment. */
  async uploadPaymentConfirmation(
    id: string,
    file: Blob,
  ): Promise<{ confirmationR2Key: string }> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn(`/api/payments/${id}/confirmation`, {
      method: "PUT",
      headers: {
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) throw new ApiError(res.status, "confirmation upload failed");
    return (await res.json()) as { confirmationR2Key: string };
  }

  /** Fetch the confirmation object for preview; null when absent. */
  async getPaymentConfirmationBlob(id: string): Promise<Blob | null> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn(`/api/payments/${id}/confirmation`, {
      headers: token !== null ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return res.blob();
  }

  // ── capture + drafts (online-only, docs/plan.md §8) ──────────────
  async capturePhoto(file: Blob): Promise<Draft> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn("/api/capture/photo", {
      method: "POST",
      headers: {
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        res.status === 429
          ? "daily capture limit reached"
          : "capture failed",
      );
    }
    return (await res.json()) as Draft;
  }

  async listDrafts(status?: Draft["status"]): Promise<Draft[]> {
    const qs = status !== undefined ? `?status=${status}` : "";
    return (
      await this.request<{ items: Draft[] }>("GET", `/api/drafts${qs}`)
    ).items;
  }

  getDraft(id: string): Promise<Draft> {
    return this.request("GET", `/api/drafts/${id}`);
  }

  setDraftStatus(
    id: string,
    status: "confirmed" | "discarded",
  ): Promise<Draft> {
    return this.request("PUT", `/api/drafts/${id}`, { status });
  }

  /** Commits a receipt draft as a payment in one server round trip:
   * the server creates the payment, copies the draft's photo (already
   * in R2) to be its confirmation, and closes the draft — all before
   * this resolves, so the caller never has to poll for the photo to
   * "catch up" the way an offline-queued write would. `id` is the
   * client-generated id for the new payment (PUT /api/payments/:id's
   * convention, kept here rather than a second request). */
  confirmDraftAsPayment(
    draftId: string,
    paymentId: string,
    input: PaymentInput,
  ): Promise<Payment> {
    return this.request("POST", `/api/drafts/${draftId}/confirm-payment`, {
      ...input,
      id: paymentId,
    });
  }

  async getDraftRawBlob(id: string): Promise<Blob | null> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn(`/api/drafts/${id}/raw`, {
      headers: token !== null ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return res.blob();
  }

  // ── calendar (docs/plan.md §9) ──────────────────────────────────
  // ── push (Phase 10) ──────────────────────────────────────────────
  /** The VAPID public key the browser needs to subscribe. `enabled`
   * false means the server has no keys, so the UI says so rather than
   * letting the user hit a permission prompt for nothing. */
  getPushConfig(): Promise<{ enabled: boolean; publicKey: string }> {
    return this.request("GET", "/api/push/config");
  }
  savePushSubscription(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<{ subscribed: boolean }> {
    return this.request("PUT", "/api/push/subscription", input);
  }
  deletePushSubscription(endpoint: string): Promise<{ subscribed: boolean }> {
    return this.request("DELETE", "/api/push/subscription", { endpoint });
  }

  /** Coordinates → a place name. Server-side so no geocoder key
   * reaches the browser; `fallback` means the lookup failed and the
   * caller should show the raw coordinates. */
  reverseGeocode(lat: number, lon: number): Promise<{
    label: string | null;
    fallback: boolean;
  }> {
    return this.request("GET", `/api/geo/reverse?lat=${lat}&lon=${lon}`);
  }

  getCalendarStatus(): Promise<{ connected: boolean; lastSyncAt: number | null }> {
    return this.request("GET", "/api/calendar/status");
  }
  connectCalendar(authCode: string): Promise<{ connected: boolean }> {
    return this.request("POST", "/api/calendar/connect", { authCode });
  }
  /** Drop the stored Google token — the way back from a wedged
   * connection, and how you re-grant against another account. */
  disconnectCalendar(): Promise<{ connected: boolean }> {
    return this.request("DELETE", "/api/calendar/connection");
  }

  /** Make the next sync exhaustive. Does not sync — that stays a
   * separate, slower action the user triggers knowingly. */
  calendarResync(): Promise<{ queued: true }> {
    return this.request("POST", "/api/calendar/resync");
  }

  /** Create a dedicated "Gigsy" calendar and move future events to it.
   * A 409 with `reconnect-required` means the grant only covers events;
   * the fix is consent for CALENDAR_APP_CREATED_SCOPE and a retry,
   * which is what `CalendarSection` does. It is emphatically NOT
   * "disconnect and reconnect" — that re-asks for `calendar.events`
   * and fails identically, which is the circle this used to send
   * people round. */
  createDedicatedCalendar(): Promise<{
    calendarId: string;
    removed: number;
    failed: number;
  }> {
    return this.request("POST", "/api/calendar/dedicated");
  }

  /**
   * Whether the stored grant can read when the user is busy (Phase 12).
   *
   * Always resolves — a narrow grant is an answer, not an error. Act on
   * the reason: `insufficient-scope` is fixed by asking for consent
   * again with CALENDAR_FREEBUSY_SCOPE, `unavailable` means Google is
   * having a moment and re-prompting would only produce a popup the
   * user did not expect and will decline.
   */
  checkCalendarFreeBusy(): Promise<
    | { readable: true }
    | {
        readable: false;
        reason: "not-connected" | "insufficient-scope" | "unavailable";
      }
  > {
    return this.request("GET", "/api/calendar/freebusy-check");
  }

  /**
   * Where this user forwards booking emails, or null when the
   * deployment has no capture domain configured.
   */
  getCaptureAddress(): Promise<{ address: string | null }> {
    return this.request("GET", "/api/capture/address");
  }

  // ── availability link (Phase 12) ─────────────────────────────────
  /** Whether a link is live and when it was made — never the token
   *  itself, which only exists in the response to createAvailabilityLink. */
  getAvailabilityLink(): Promise<{
    active: { createdAt: number; expiresAt: number | null } | null;
  }> {
    return this.request("GET", "/api/availability/link");
  }

  /**
   * Mint a link, invalidating whatever came before.
   *
   * This is the ONLY moment the token exists outside the browser that
   * receives it: the server keeps a hash, so it can never be shown
   * again. Whatever calls this has to put it in front of the user now.
   */
  createAvailabilityLink(expiresInDays: number | null = null): Promise<{
    token: string;
    path: string;
    createdAt: number;
    expiresAt: number | null;
  }> {
    return this.request("POST", "/api/availability/link", { expiresInDays });
  }

  revokeAvailabilityLink(): Promise<{ active: null }> {
    return this.request("DELETE", "/api/availability/link");
  }

  // ── settings (Phase 11) ──────────────────────────────────────────
  getSettings(): Promise<Settings> {
    return this.request("GET", "/api/settings");
  }
  /** Server-side merge: sending one setting never disturbs the others,
   * so two screens editing different settings cannot clobber. */
  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.request("PATCH", "/api/settings", patch);
  }

  calendarSyncNow(): Promise<{
    created: number;
    updated: number;
    deleted: number;
    failed: number;
    /** Present only when failures share an actionable cause. */
    failureReason?: "api-disabled" | "auth" | "other";
  }> {
    return this.request("POST", "/api/calendar/sync-now");
  }

  // ── reports ──────────────────────────────────────────────────────
  getReportSummary(filters: ReportFilters = {}): Promise<ReportSummary> {
    const params = new URLSearchParams();
    if (filters.from !== undefined) params.set("from", String(filters.from));
    if (filters.to !== undefined) params.set("to", String(filters.to));
    if (filters.clientId !== undefined) params.set("clientId", filters.clientId);
    const qs = params.toString();
    return this.request("GET", `/api/reports/summary${qs ? `?${qs}` : ""}`);
  }

  getDashboard(window: { futureFrom?: number; futureTo?: number } = {}): Promise<DashboardSummary> {
    const params = new URLSearchParams();
    if (window.futureFrom !== undefined) params.set("futureFrom", String(window.futureFrom));
    if (window.futureTo !== undefined) params.set("futureTo", String(window.futureTo));
    const qs = params.toString();
    return this.request("GET", `/api/reports/dashboard${qs ? `?${qs}` : ""}`);
  }

  // ── sync (offline outbox drain, docs/plan.md §7) ─────────────────
  sync(ops: SyncOp[]): Promise<{ results: SyncOpResult[] }> {
    return this.request("POST", "/api/sync", { ops });
  }

  // ── debug (hidden console; JWT-guarded server-side) ──────────────
  getDebugLogs(limit: number): Promise<{ entries: WorkerLogEntry[] }> {
    return this.request("GET", `/api/debug/logs?limit=${limit}`);
  }
}

export interface SyncOp {
  entity: "client" | "gig" | "expense" | "service" | "payment" | "allocation";
  op: "upsert" | "delete";
  id: string;
  /** Client edit time (epoch ms) — the LWW conflict signal. */
  modifiedAt: number;
  payload?: unknown;
}

export interface SyncOpResult {
  id: string;
  status: "applied" | "skipped" | "error";
  reason?: string;
}

/** Shape of backend log entries (mirrors backend/src/logger.ts). */
export interface WorkerLogEntry {
  ts: number;
  level: string;
  msg: string;
  data?: unknown;
}

/** Unauthenticated auth endpoints (used by AuthManager). */
export class AuthApiClient implements AuthApi {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn?: typeof fetch) {
    // Same "Illegal invocation" guard as ApiClient.
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  async getConfig(): Promise<{
    googleClientId: string;
    testAuthEnabled: boolean;
    /** Whether an allowlist is in force — never who is on it. Lets the
     *  login screen explain a refusal instead of just failing. */
    inviteOnly: boolean;
  }> {
    const res = await this.fetchFn("/api/auth/config");
    if (!res.ok) throw new ApiError(res.status, "config unavailable");
    return (await res.json()) as {
      googleClientId: string;
      testAuthEnabled: boolean;
      inviteOnly: boolean;
    };
  }

  /** Google-free sign-in for tests/dev. The endpoint only exists
   * outside production (404 there) — this throws in that case. */
  async testLogin(email: string): Promise<AuthSession> {
    const res = await this.fetchFn("/api/auth/test-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new ApiError(res.status, "test auth unavailable");
    return (await res.json()) as AuthSession;
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

  /**
   * Session restore, on a leash. `fetch` has no default timeout, so a
   * connection that accepts but never answers — a phone waking onto a
   * captive-portal Wi-Fi is the everyday case — would hang this call
   * forever and freeze the whole app behind the startup gate.
   *
   * The outcome is three-way on purpose: only the server explicitly
   * rejecting the token (401/403) means the session is dead. A
   * timeout, a network error, or a 5xx from the worker says nothing
   * about the token, so the caller keeps it and retries later.
   */
  async refreshSession(refreshToken: string): Promise<RefreshResult> {
    const abort = new AbortController();
    // Not AbortSignal.timeout(): older iOS Safari — the primary
    // device — doesn't have it.
    const timer = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: abort.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "rejected" };
      }
      if (!res.ok) return { ok: false, reason: "unreachable" };
      return { ok: true, tokens: (await res.json()) as SessionTokens };
    } catch {
      // Aborted, offline, DNS failure — all indistinguishable here,
      // and all mean "ask again later", never "sign the user out".
      return { ok: false, reason: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
