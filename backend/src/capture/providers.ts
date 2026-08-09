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
    if (input.kind === "image") {
      parts.push({
        inline_data: { mime_type: input.mimeType, data: input.dataBase64 },
      });
    } else {
      parts.push({ text: input.text ?? "" });
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
    const content: Record<string, unknown>[] =
      input.kind === "image"
        ? [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: input.mimeType,
                data: input.dataBase64,
              },
            },
            { type: "text", text: EXTRACTION_PROMPT },
          ]
        : [{ type: "text", text: `${EXTRACTION_PROMPT}\n\n${input.text ?? ""}` }];
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

export function providerFromEnv(env: Bindings): ExtractionProvider {
  const provider = env.AI_PROVIDER;
  if (provider === "anthropic" && env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(env.AI_MODEL, env.ANTHROPIC_API_KEY);
  }
  if (provider === "stub" && env.ENVIRONMENT !== "production") {
    return new StubProvider();
  }
  // Default and every production fallback: the configured Gemini.
  return new GeminiProvider(env.AI_MODEL, env.GEMINI_API_KEY);
}
