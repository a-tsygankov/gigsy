/**
 * Extraction providers (docs/plan.md §8 + §20 handoff note: model
 * choice is CONFIG, not code). `AI_PROVIDER`/`AI_MODEL` vars pick the
 * implementation; call sites only see ExtractionProvider. fetch is
 * injected everywhere — unit tests never touch real APIs.
 *
 * The stub exists for dev/e2e (no AI cost, deterministic) and is
 * structurally impossible in production: providerFromEnv falls back
 * to the real primary there.
 */
import type { Bindings } from "../env.ts";
import { log } from "../logger.ts";
import {
  EXTRACTION_PROMPT,
  parseExtractionText,
  type ExtractedDataT,
  type ExtractionInput,
  type ExtractionProvider,
} from "./extraction.ts";

export class GeminiProvider implements ExtractionProvider {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  async extract(input: ExtractionInput): Promise<ExtractedDataT | null> {
    const parts: Record<string, unknown>[] = [{ text: EXTRACTION_PROMPT }];
    for (const item of input.media ?? []) {
      parts.push({
        inline_data: { mime_type: item.mimeType, data: item.dataBase64 },
      });
    }
    if (input.text !== undefined && input.text !== "") {
      parts.push({ text: input.text });
    }
    try {
      const res = await this.fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0 },
          }),
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      return text === undefined ? null : parseExtractionText(text);
    } catch {
      return null;
    }
  }
}

export class AnthropicProvider implements ExtractionProvider {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  async extract(input: ExtractionInput): Promise<ExtractedDataT | null> {
    // Images first, then one text block — the order this provider was
    // already using for photo capture.
    const content: Record<string, unknown>[] = (input.media ?? []).map(
      (item) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: item.mimeType,
          data: item.dataBase64,
        },
      }),
    );
    content.push({
      type: "text",
      text:
        input.text !== undefined && input.text !== ""
          ? `${EXTRACTION_PROMPT}\n\n${input.text}`
          : EXTRACTION_PROMPT,
    });
    try {
      const res = await this.fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text = body.content?.find((b) => b.type === "text")?.text;
      return text === undefined ? null : parseExtractionText(text);
    } catch {
      return null;
    }
  }
}

/** Deterministic canned extraction for dev/e2e — never in production. */
export class StubProvider implements ExtractionProvider {
  async extract(_input: ExtractionInput): Promise<ExtractedDataT | null> {
    return {
      kind: "gig",
      clientName: "Stub Staffing Co",
      location: "Stubville Expo Hall",
      dateTimeMs: null,
      amountOfferedCents: 12500,
      amountCents: null,
      category: null,
      notes: "Extracted by the stub provider (dev/e2e only).",
    };
  }
}

/**
 * Ordered chain — the first provider to return an extraction wins
 * (Phase 8 hardening plan). This is what keeps capture working when
 * the primary model is rate-limited or its free tier is exhausted,
 * the last open item in docs/plan.md §14.
 *
 * Falling through on `null` rather than only on transport errors is
 * deliberate: the providers already collapse HTTP failures and
 * unreadable replies into the same `null`, and for this workload that
 * is useful — if one model can't read a crumpled receipt, asking the
 * other is what a person would do. `AI_DAILY_CAP` bounds the cost at
 * two calls per capture.
 */
export class FallbackProvider implements ExtractionProvider {
  constructor(readonly providers: ExtractionProvider[]) {}

  async extract(input: ExtractionInput): Promise<ExtractedDataT | null> {
    for (const [index, provider] of this.providers.entries()) {
      const result = await provider.extract(input);
      if (result !== null) return result;
      if (index < this.providers.length - 1) {
        log.warn("extraction provider yielded nothing — trying the next", {
          provider: provider.constructor.name,
        });
      }
    }
    return null;
  }
}

export function providerFromEnv(env: Bindings): ExtractionProvider {
  // The stub is dev/e2e only and never has a partner.
  if (env.AI_PROVIDER === "stub" && env.ENVIRONMENT !== "production") {
    return new StubProvider();
  }

  const gemini = env.GEMINI_API_KEY
    ? new GeminiProvider(env.AI_MODEL, env.GEMINI_API_KEY)
    : null;
  const anthropic = env.ANTHROPIC_API_KEY
    ? new AnthropicProvider(env.AI_MODEL, env.ANTHROPIC_API_KEY)
    : null;

  // Primary first, then whatever else is configured. Anything other
  // than "anthropic" — including "stub" in production — leads with
  // Gemini, the documented default.
  const ordered: (ExtractionProvider | null)[] =
    env.AI_PROVIDER === "anthropic" ? [anthropic, gemini] : [gemini, anthropic];
  const chain = ordered.filter((p): p is ExtractionProvider => p !== null);

  if (chain.length === 0) {
    // No key configured at all: keep the previous shape and let the
    // call fail at the API, not here.
    return new GeminiProvider(env.AI_MODEL, env.GEMINI_API_KEY);
  }
  return chain.length === 1 ? chain[0]! : new FallbackProvider(chain);
}
