import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError, type TokenSource } from "./api.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubTokens(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    getAccessToken: async () => "token-1",
    refresh: async () => false,
    onSessionExpired: vi.fn(),
    ...overrides,
  };
}

describe("ApiClient", () => {
  it("sends the bearer token and unwraps list items", async () => {
    let seenAuth = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
      expect(String(url)).toBe("/api/gigs");
      return jsonResponse({ items: [{ id: "g1" }] });
    }) as typeof fetch;

    const api = new ApiClient(stubTokens(), fetchFn);
    const gigs = await api.listGigs();

    expect(seenAuth).toBe("Bearer token-1");
    expect(gigs).toEqual([{ id: "g1" }]);
  });

  it("PUTs JSON and returns the record", async () => {
    let seenBody = "";
    let seenMethod = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body);
      return jsonResponse({ id: "c1", name: "Acme" }, 201);
    }) as typeof fetch;

    const api = new ApiClient(stubTokens(), fetchFn);
    const client = await api.putClient("c1", { name: "Acme" });

    expect(seenMethod).toBe("PUT");
    expect(JSON.parse(seenBody)).toEqual({ name: "Acme" });
    expect(client).toEqual({ id: "c1", name: "Acme" });
  });

  it("retries once after a 401 when refresh succeeds", async () => {
    let calls = 0;
    let token = "stale";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer fresh") return jsonResponse({ items: [] });
      return jsonResponse({ error: "unauthorized" }, 401);
    }) as typeof fetch;

    const tokens = stubTokens({
      getAccessToken: async () => token,
      refresh: async () => {
        token = "fresh";
        return true;
      },
    });

    const api = new ApiClient(tokens, fetchFn);
    await expect(api.listGigs()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("signals session expiry when refresh fails after a 401", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
    const onSessionExpired = vi.fn();
    const api = new ApiClient(
      stubTokens({ refresh: async () => false, onSessionExpired }),
      fetchFn,
    );

    await expect(api.listGigs()).rejects.toThrow(ApiError);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("throws ApiError with status on non-OK responses", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "not found" }, 404)) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);

    const err = await api.getGig("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("DELETE resolves on 204", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);
    await expect(api.deleteExpense("e1")).resolves.toBeUndefined();
  });

  it("fetches debug logs with the bearer token", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
      return jsonResponse({ entries: [{ ts: 1, level: "info", msg: "m" }] });
    }) as typeof fetch;

    const api = new ApiClient(stubTokens(), fetchFn);
    const body = await api.getDebugLogs(25);

    expect(seenUrl).toBe("/api/debug/logs?limit=25");
    expect(seenAuth).toBe("Bearer token-1");
    expect(body.entries).toHaveLength(1);
  });

  it("services/payments/dashboard endpoints hit the right URLs", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      return jsonResponse(
        String(url).includes("dashboard")
          ? { completedCount: 0, expectedCents: 0, unpaidCents: 0, unpaidJobs: [] }
          : String(url).includes("?") || init?.method === "PUT"
            ? { id: "x" }
            : { items: [] },
      );
    }) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);

    await api.listServices();
    await api.putService("s1", { gigId: "g1", description: "d" });
    await api.listPayments();
    await api.getDashboard({ futureFrom: 5, futureTo: 9 });

    expect(seen).toEqual([
      "GET /api/services",
      "PUT /api/services/s1",
      "GET /api/payments",
      "GET /api/reports/dashboard?futureFrom=5&futureTo=9",
    ]);
  });

  it("uploads a payment confirmation with bearer + content type", async () => {
    let seenAuth = "";
    let seenType = "";
    let seenMethod = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method ?? "";
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      seenType = headers.get("content-type") ?? "";
      return jsonResponse({ confirmationR2Key: "k" });
    }) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await api.uploadPaymentConfirmation("p1", blob);

    expect(seenMethod).toBe("PUT");
    expect(seenAuth).toBe("Bearer token-1");
    expect(seenType).toBe("image/png");
  });

  it("capture + drafts endpoints hit the right URLs with bearer", async () => {
    const seen: string[] = [];
    let captureAuth = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("capture")) {
        captureAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return jsonResponse({ id: "d1", extracted: { kind: "gig" } });
      }
      return jsonResponse(
        String(url).endsWith("/api/drafts?status=pending")
          ? { items: [] }
          : { id: "d1" },
      );
    }) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);

    await api.capturePhoto(new Blob([new Uint8Array([1])], { type: "image/png" }));
    await api.listDrafts("pending");
    await api.setDraftStatus("d1", "confirmed");

    expect(captureAuth).toBe("Bearer token-1");
    expect(seen).toEqual([
      "POST /api/capture/photo",
      "GET /api/drafts?status=pending",
      "PUT /api/drafts/d1",
    ]);
  });

  it("calendar endpoints hit the right URLs with bearer", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      return jsonResponse(
        String(url).includes("status")
          ? { connected: false, lastSyncAt: null }
          : { connected: true },
      );
    }) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);

    await api.getCalendarStatus();
    await api.connectCalendar("auth-code");
    await api.calendarSyncNow();

    expect(seen).toEqual([
      "GET /api/calendar/status",
      "POST /api/calendar/connect",
      "POST /api/calendar/sync-now",
    ]);
  });

  it("POSTs sync ops and returns per-op results", async () => {
    let seenBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({ results: [{ id: "x", status: "applied" }] });
    }) as typeof fetch;

    const api = new ApiClient(stubTokens(), fetchFn);
    const ops = [
      {
        entity: "client" as const,
        op: "upsert" as const,
        id: "x",
        modifiedAt: 5,
        payload: { name: "A" },
      },
    ];
    const body = await api.sync(ops);

    expect(JSON.parse(seenBody)).toEqual({ ops });
    expect(body.results[0]).toEqual({ id: "x", status: "applied" });
  });
});
