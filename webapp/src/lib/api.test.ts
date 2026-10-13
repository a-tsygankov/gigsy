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

  // A 401 whose refresh fails is reported, not acted on: only the
  // token source knows whether the refresh failed because the session
  // is dead or merely because the network is down, and tearing the
  // session down here would sign the user out every time they opened
  // the app offline.
  it("reports a 401 whose refresh failed without ending the session", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
    const refresh = vi.fn(async () => false);
    const api = new ApiClient(stubTokens({ refresh }), fetchFn);

    await expect(api.listGigs()).rejects.toThrow(ApiError);
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("POSTs feedback as multipart with the message, page, version and one part per image", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenHeaders: Headers | null = null;
    let seenBody: unknown = null;
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      seenHeaders = new Headers(init?.headers);
      seenBody = init?.body;
      return jsonResponse({ id: "f1", emailStatus: "unsent" });
    }) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.jpg", { type: "image/jpeg" });

    const receipt = await api.sendFeedback({
      message: "The gig list is empty",
      page: "/gigs",
      clientVersion: "0.0.189",
      images: [a, b],
    });

    expect(seenUrl).toBe("/api/feedback");
    expect(seenMethod).toBe("POST");
    expect(seenHeaders!.get("Authorization")).toBe("Bearer token-1");
    // The browser writes `multipart/form-data; boundary=…` itself from
    // the FormData body; a content-type set here would lack the
    // boundary and the server could not split the parts.
    expect(seenHeaders!.has("content-type")).toBe(false);
    expect(seenBody).toBeInstanceOf(FormData);
    const form = seenBody as FormData;
    expect(form.get("message")).toBe("The gig list is empty");
    expect(form.get("page")).toBe("/gigs");
    expect(form.get("clientVersion")).toBe("0.0.189");
    const images = form.getAll("image");
    expect(images).toHaveLength(2);
    expect(images.map((part) => (part as File).name)).toEqual(["a.png", "b.jpg"]);
    expect(images.map((part) => (part as File).type)).toEqual(["image/png", "image/jpeg"]);
    expect(receipt).toEqual({ id: "f1", emailStatus: "unsent" });
  });

  /** A fetch that keeps the FormData it was handed, for the part checks. */
  function capturingFeedbackFetch() {
    const seen: { body: FormData | null } = { body: null };
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.body = init?.body as FormData;
      return jsonResponse({ id: "f2", emailStatus: "sent" });
    }) as typeof fetch;
    return { seen, fetchFn };
  }

  const CAPTURE_PARTS = ["kind", "draftId", "corrected", "stage", "error"];

  it("sends a general message with none of the capture-error parts", async () => {
    // The old contract, byte for byte: a part the server does not
    // expect is a 400, so absent must mean absent, not "".
    const { seen, fetchFn } = capturingFeedbackFetch();
    const api = new ApiClient(stubTokens(), fetchFn);
    await api.sendFeedback({ message: "hi", page: "/", clientVersion: "0", images: [] });
    for (const part of CAPTURE_PARTS) expect(seen.body!.has(part)).toBe(false);
  });

  it("adds the capture-error parts of a review report, corrected as JSON", async () => {
    const { seen, fetchFn } = capturingFeedbackFetch();
    const api = new ApiClient(stubTokens(), fetchFn);
    const corrected = {
      kind: "gig" as const,
      clientName: "Acme",
      location: null,
      dateTimes: [1_700_000_000_000],
      amountCents: 15000,
      category: null,
      notes: null,
    };
    const receipt = await api.sendFeedback({
      message: "Capture read 1 field wrong: Amount",
      page: "/drafts/d1",
      clientVersion: "0.0.190",
      images: [],
      kind: "capture-error",
      draftId: "d1",
      corrected,
      stage: "review",
    });
    const form = seen.body!;
    expect(form.get("kind")).toBe("capture-error");
    expect(form.get("draftId")).toBe("d1");
    expect(JSON.parse(form.get("corrected") as string)).toEqual(corrected);
    expect(form.get("stage")).toBe("review");
    // Only what was given: no error on the review path, no images.
    expect(form.has("error")).toBe(false);
    expect(form.getAll("image")).toHaveLength(0);
    expect(receipt).toEqual({ id: "f2", emailStatus: "sent" });
  });

  it("adds the stage, the error and the chosen file for an extraction failure", async () => {
    const { seen, fetchFn } = capturingFeedbackFetch();
    const api = new ApiClient(stubTokens(), fetchFn);
    const flyer = new File(["png"], "flyer.png", { type: "image/png" });
    await api.sendFeedback({
      message: "Capture could not read this.",
      page: "/capture",
      clientVersion: "0",
      images: [flyer],
      kind: "capture-error",
      stage: "extraction-failed",
      error: "capture failed",
    });
    const form = seen.body!;
    expect(form.get("kind")).toBe("capture-error");
    expect(form.get("stage")).toBe("extraction-failed");
    expect(form.get("error")).toBe("capture failed");
    expect(form.has("draftId")).toBe(false);
    expect(form.has("corrected")).toBe(false);
    expect((form.get("image") as File).name).toBe("flyer.png");
  });

  it("turns a 413 on feedback into an ApiError a person can read", async () => {
    const fetchFn = (async () => new Response("", { status: 413 })) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);
    const attempt = api.sendFeedback({
      message: "x",
      page: "/",
      clientVersion: "0",
      images: [],
    });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({
      status: 413,
      message: "That's too much to send at once — try fewer or smaller images.",
    });
  });

  it("shows the server's own sentence for a feedback 400", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "message is required" }, 400)) as typeof fetch;
    const api = new ApiClient(stubTokens(), fetchFn);
    await expect(
      api.sendFeedback({ message: "", page: "/", clientVersion: "0", images: [] }),
    ).rejects.toMatchObject({ status: 400, message: "message is required" });
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
