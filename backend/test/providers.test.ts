/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  AnthropicProvider,
  FallbackProvider,
  GeminiProvider,
  StubProvider,
  providerFromEnv,
} from "../src/capture/providers.ts";
import type { Bindings } from "../src/env.ts";
import {
  parseExtractionText,
  type ExtractedDataT,
  type ExtractionProvider,
} from "../src/capture/extraction.ts";

const IMAGE_INPUT = {
  media: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }],
};

const TEXT_AND_MEDIA_INPUT = {
  text: "Tasting stand Saturday, $150",
  media: [
    { mimeType: "image/png", dataBase64: "aGVsbG8=" },
    { mimeType: "image/jpeg", dataBase64: "d29ybGQ=" },
  ],
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

describe("providers with text and media together", () => {
  it("Gemini sends the prompt, every image, and the text", async () => {
    let seenBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(EXTRACTION) }] } },
        ],
      });
    }) as typeof fetch;

    await new GeminiProvider("gemini-2.5-flash", "k", fetchFn).extract(
      TEXT_AND_MEDIA_INPUT,
    );

    const parts = (
      JSON.parse(seenBody) as { contents: { parts: Record<string, unknown>[] }[] }
    ).contents[0]!.parts;
    expect(parts.filter((p) => "inline_data" in p)).toHaveLength(2);
    const texts = parts.filter((p) => "text" in p).map((p) => p["text"] as string);
    expect(texts.some((t) => t.includes("Tasting stand Saturday"))).toBe(true);
  });

  it("Anthropic sends every image plus one text block", async () => {
    let seenBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({
        content: [{ type: "text", text: JSON.stringify(EXTRACTION) }],
      });
    }) as typeof fetch;

    await new AnthropicProvider("claude-x", "k", fetchFn).extract(
      TEXT_AND_MEDIA_INPUT,
    );

    const content = (
      JSON.parse(seenBody) as {
        messages: { content: { type: string; text?: string }[] }[];
      }
    ).messages[0]!.content;
    expect(content.filter((b) => b.type === "image")).toHaveLength(2);
    expect(content.find((b) => b.type === "text")?.text ?? "").toContain(
      "Tasting stand Saturday",
    );
  });

  it("a text-only input sends no image blocks", async () => {
    let seenBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(EXTRACTION) }] } },
        ],
      });
    }) as typeof fetch;

    await new GeminiProvider("gemini-2.5-flash", "k", fetchFn).extract({
      text: "just words",
    });

    const parts = (
      JSON.parse(seenBody) as { contents: { parts: Record<string, unknown>[] }[] }
    ).contents[0]!.parts;
    expect(parts.filter((p) => "inline_data" in p)).toHaveLength(0);
  });
});

describe("StubProvider + providerFromEnv", () => {
  it("stub returns a canned gig extraction (dev/e2e)", async () => {
    const result = await new StubProvider().extract(IMAGE_INPUT);
    expect(result?.kind).toBe("gig");
    expect(result?.clientName).toBeTruthy();
  });

  // One key configured: a lone provider, unwrapped — there is nothing
  // to fall back to.
  it("selects by AI_PROVIDER and never allows stub in production", () => {
    const gemOnly = {
      AI_MODEL: "m",
      GEMINI_API_KEY: "k",
    } as Partial<Bindings> as Bindings;
    const anthOnly = {
      AI_MODEL: "m",
      ANTHROPIC_API_KEY: "a",
    } as Partial<Bindings> as Bindings;

    expect(
      providerFromEnv({ ...gemOnly, AI_PROVIDER: "gemini", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(GeminiProvider);
    expect(
      providerFromEnv({ ...anthOnly, AI_PROVIDER: "anthropic", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      providerFromEnv({ ...gemOnly, AI_PROVIDER: "stub", ENVIRONMENT: "development" }),
    ).toBeInstanceOf(StubProvider);
    // Production never runs the stub — falls back to the real primary.
    expect(
      providerFromEnv({ ...gemOnly, AI_PROVIDER: "stub", ENVIRONMENT: "production" }),
    ).toBeInstanceOf(GeminiProvider);
  });

  // Both keys configured: the secondary is what ANTHROPIC_API_KEY was
  // reserved for in the secrets matrix (docs/plan.md §11).
  it("chains the configured providers, primary first", () => {
    const both = {
      AI_MODEL: "m",
      GEMINI_API_KEY: "k",
      ANTHROPIC_API_KEY: "a",
      ENVIRONMENT: "production",
    } as Partial<Bindings> as Bindings;

    const gemLed = providerFromEnv({ ...both, AI_PROVIDER: "gemini" });
    expect(gemLed).toBeInstanceOf(FallbackProvider);
    expect((gemLed as FallbackProvider).providers[0]).toBeInstanceOf(GeminiProvider);
    expect((gemLed as FallbackProvider).providers[1]).toBeInstanceOf(AnthropicProvider);

    const anthLed = providerFromEnv({ ...both, AI_PROVIDER: "anthropic" });
    expect(anthLed).toBeInstanceOf(FallbackProvider);
    expect((anthLed as FallbackProvider).providers[0]).toBeInstanceOf(AnthropicProvider);
    expect((anthLed as FallbackProvider).providers[1]).toBeInstanceOf(GeminiProvider);
  });

  it("keeps the stub single — it never has a partner", () => {
    const both = {
      AI_MODEL: "m",
      GEMINI_API_KEY: "k",
      ANTHROPIC_API_KEY: "a",
      AI_PROVIDER: "stub",
      ENVIRONMENT: "development",
    } as Partial<Bindings> as Bindings;
    expect(providerFromEnv(both)).toBeInstanceOf(StubProvider);
  });
});

describe("FallbackProvider", () => {
  const canned: ExtractedDataT = {
    kind: "gig",
    clientName: "Acme",
    location: null,
    dateTimeMs: null,
    amountOfferedCents: null,
    amountCents: null,
    category: null,
    notes: null,
  };

  function spy(result: ExtractedDataT | null) {
    const calls: number[] = [];
    const provider: ExtractionProvider = {
      extract: async () => {
        calls.push(1);
        return result;
      },
    };
    return { provider, calls };
  }

  it("returns the primary's extraction without touching the fallback", async () => {
    const primary = spy(canned);
    const secondary = spy(canned);

    const result = await new FallbackProvider([
      primary.provider,
      secondary.provider,
    ]).extract(IMAGE_INPUT);

    expect(result).toEqual(canned);
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(0);
  });

  // A provider collapses both transport failures and unreadable
  // replies into null; trying the other model on either is exactly
  // what a person would do with a crumpled receipt.
  it("falls through to the next provider when the primary yields nothing", async () => {
    const primary = spy(null);
    const secondary = spy(canned);

    const result = await new FallbackProvider([
      primary.provider,
      secondary.provider,
    ]).extract(IMAGE_INPUT);

    expect(result).toEqual(canned);
    expect(secondary.calls).toHaveLength(1);
  });

  it("yields null once every provider has failed", async () => {
    const result = await new FallbackProvider([
      spy(null).provider,
      spy(null).provider,
    ]).extract(IMAGE_INPUT);

    expect(result).toBeNull();
  });
});

// dateTimesMs (gig batches, 2026-09-18): every date a booking sheet
// names, so the review screen can seed one row per shift. It is a
// separate field rather than a change to dateTimeMs so that a draft
// stored before it existed — and the stub, whose exact output the e2e
// suite depends on — still parses; the third case is that promise.
describe("parseExtractionText dateTimesMs", () => {
  it("parses several entries in document order", () => {
    const result = parseExtractionText(
      JSON.stringify({
        ...EXTRACTION,
        dateTimeMs: 1_700_000_000_000,
        dateTimesMs: [1_700_000_000_000, 1_700_086_400_000, 1_700_172_800_000],
      }),
    );
    expect(result?.dateTimesMs).toEqual([
      1_700_000_000_000, 1_700_086_400_000, 1_700_172_800_000,
    ]);
    expect(result?.dateTimeMs).toBe(1_700_000_000_000);
  });

  // A model that answers with an ISO string or a fractional number in
  // the list has not followed the prompt, and the whole reply is
  // refused rather than the one entry dropped: a partial list of
  // dates would create fewer gigs than the document names, silently.
  it("refuses a reply whose list holds a non-integer", () => {
    expect(
      parseExtractionText(
        JSON.stringify({ ...EXTRACTION, dateTimesMs: [1_700_000_000_000, 1.5] }),
      ),
    ).toBeNull();
    expect(
      parseExtractionText(
        JSON.stringify({ ...EXTRACTION, dateTimesMs: ["2026-09-18"] }),
      ),
    ).toBeNull();
  });

  it("still parses a reply without the field", () => {
    const result = parseExtractionText(JSON.stringify(EXTRACTION));
    expect(result?.kind).toBe("gig");
    expect(result?.dateTimesMs ?? null).toBeNull();
  });
});

// PDF as a capture input (gig batches, 2026-09-18). Each provider
// encodes a PDF its own way — Anthropic wants a `document` block where
// an image is an `image` block — which is exactly the provider-specific
// knowledge attachments.ts keeps out of email capture. Here it stays
// inside the provider, so the capture route hands over a mime type and
// bytes the same as ever.
describe("AnthropicProvider with a PDF", () => {
  const PDF_INPUT = {
    media: [{ mimeType: "application/pdf", dataBase64: "JVBERi0=" }],
  };

  function capture(): { fetchFn: typeof fetch; body: () => string } {
    let seenBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({
        content: [{ type: "text", text: JSON.stringify(EXTRACTION) }],
      });
    }) as typeof fetch;
    return { fetchFn, body: () => seenBody };
  }

  type Block = {
    type: string;
    source?: { type: string; media_type: string; data: string };
  };
  const blocksOf = (body: string): Block[] =>
    (JSON.parse(body) as { messages: { content: Block[] }[] }).messages[0]!.content;

  it("sends a PDF as a document block", async () => {
    const { fetchFn, body } = capture();
    await new AnthropicProvider("claude-x", "k", fetchFn).extract(PDF_INPUT);

    const blocks = blocksOf(body());
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    const doc = blocks.find((b) => b.type === "document");
    expect(doc?.source).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: "JVBERi0=",
    });
  });

  it("still sends an image as an image block", async () => {
    const { fetchFn, body } = capture();
    await new AnthropicProvider("claude-x", "k", fetchFn).extract(IMAGE_INPUT);

    const blocks = blocksOf(body());
    expect(blocks.filter((b) => b.type === "document")).toHaveLength(0);
    expect(blocks.find((b) => b.type === "image")?.source?.media_type).toBe(
      "image/png",
    );
  });

  it("keeps a PDF and an image side by side, each in its own block", async () => {
    const { fetchFn, body } = capture();
    await new AnthropicProvider("claude-x", "k", fetchFn).extract({
      media: [...PDF_INPUT.media, ...IMAGE_INPUT.media],
    });

    const types = blocksOf(body()).map((b) => b.type);
    expect(types).toEqual(["document", "image", "text"]);
  });
});
