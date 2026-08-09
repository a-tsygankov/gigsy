/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  StubProvider,
  providerFromEnv,
} from "../src/capture/providers.ts";
import type { Bindings } from "../src/env.ts";

const IMAGE_INPUT = {
  kind: "image" as const,
  mimeType: "image/png",
  dataBase64: "aGVsbG8=",
};

const EXTRACTION = {
  kind: "gig",
  clientName: "Acme Staffing",
  location: "Costco on 5th",
  amountOfferedCents: 15000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GeminiProvider", () => {
  it("calls generateContent with the model, image part, and parses JSON", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body);
      return jsonResponse({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(EXTRACTION) }] } },
        ],
      });
    }) as typeof fetch;

    const provider = new GeminiProvider("gemini-2.5-flash", "key-123", fetchFn);
    const result = await provider.extract(IMAGE_INPUT);

    expect(seenUrl).toContain("models/gemini-2.5-flash:generateContent");
    expect(seenUrl).toContain("key=key-123");
    const body = JSON.parse(seenBody) as {
      contents: { parts: Record<string, unknown>[] }[];
    };
    expect(
      body.contents[0]?.parts.some(
        (p) =>
          (p["inline_data"] as { data?: string } | undefined)?.data === "aGVsbG8=",
      ),
    ).toBe(true);
    expect(result?.clientName).toBe("Acme Staffing");
    expect(result?.amountOfferedCents).toBe(15000);
  });

  it("survives markdown-fenced JSON and returns null on garbage", async () => {
    const fenced = (async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "```json\n" + JSON.stringify(EXTRACTION) + "\n```" }],
            },
          },
        ],
      })) as typeof fetch;
    expect(
      (await new GeminiProvider("m", "k", fenced).extract(IMAGE_INPUT))?.kind,
    ).toBe("gig");

    const garbage = (async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "sorry, no idea" }] } }],
      })) as typeof fetch;
    expect(await new GeminiProvider("m", "k", garbage).extract(IMAGE_INPUT)).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    const fetchFn = (async () => new Response("quota", { status: 429 })) as typeof fetch;
    expect(
      await new GeminiProvider("m", "k", fetchFn).extract(IMAGE_INPUT),
    ).toBeNull();
  });
});

describe("AnthropicProvider", () => {
  it("calls the messages API with an image block and parses JSON", async () => {
    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = new Headers(init?.headers);
      seenBody = String(init?.body);
      return jsonResponse({
        content: [{ type: "text", text: JSON.stringify(EXTRACTION) }],
      });
    }) as typeof fetch;

    const provider = new AnthropicProvider("claude-haiku-4-5-20251001", "sk-x", fetchFn);
    const result = await provider.extract(IMAGE_INPUT);

    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(seenHeaders?.get("x-api-key")).toBe("sk-x");
    expect(seenHeaders?.get("anthropic-version")).toBeTruthy();
    const body = JSON.parse(seenBody) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(result?.kind).toBe("gig");
  });
});

describe("StubProvider + providerFromEnv", () => {
  it("stub returns a canned gig extraction (dev/e2e)", async () => {
    const result = await new StubProvider().extract(IMAGE_INPUT);
    expect(result?.kind).toBe("gig");
    expect(result?.clientName).toBeTruthy();
  });

  it("selects by AI_PROVIDER and never allows stub in production", () => {
    const base = {
      AI_MODEL: "m",
      GEMINI_API_KEY: "k",
      ANTHROPIC_API_KEY: "a",
    } as Partial<Bindings> as Bindings;

    expect(
      providerFromEnv({ ...base, AI_PROVIDER: "gemini", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(GeminiProvider);
    expect(
      providerFromEnv({ ...base, AI_PROVIDER: "anthropic", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      providerFromEnv({ ...base, AI_PROVIDER: "stub", ENVIRONMENT: "development" }),
    ).toBeInstanceOf(StubProvider);
    // Production never runs the stub — falls back to the real primary.
    expect(
      providerFromEnv({ ...base, AI_PROVIDER: "stub", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(GeminiProvider);
  });
});
