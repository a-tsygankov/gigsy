# Email capture: HTML bodies and image attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make forwarded booking emails extract properly — read HTML-only
bodies instead of just the subject line, and send image attachments to the
model alongside the text.

**Architecture:** `ExtractionInput` stops being an either/or (`kind:
"image" | "text"`) and becomes `{ text?, media? }`, which both providers
already have the shape to consume — each builds a multi-part content array
and simply never receives more than one item today. Two new pure modules sit
in front of it: `html-text.ts` turns an HTML body into text using
`HTMLRewriter`, and `attachments.ts` decides which attachments are worth
paying to look at. `capture-service.ts` gains a `notesSuffix` so anything
skipped is named in the draft rather than silently dropped.

**Tech Stack:** Cloudflare Workers, Hono, `postal-mime` 2.7.6, `HTMLRewriter`
(runtime built-in, no new dependency), Vitest with
`@cloudflare/vitest-pool-workers`, Drizzle/D1.

**Background:** the `email()` handler has worked since Phase 5 (see
[2026-08-10-email-capture-activation.md](2026-08-10-email-capture-activation.md))
but reads `subject + parsed.text` only. `docs/plan.md` §8 promises "body +
attachments". PDFs are deliberately out of scope: Gemini wants `inline_data`
and Anthropic wants a `document` block, so supporting them breaks the
provider-agnostic call site the code protects. They get named in the draft
note instead.

---

## File Structure

**Create:**
- `backend/src/capture/html-text.ts` — HTML body → plain text. One export.
- `backend/src/capture/attachments.ts` — which attachments reach the model,
  and what to say about the ones that don't.
- `backend/src/lib/base64.ts` — `toBase64`, moved out of `capture-service.ts`
  so `attachments.ts` can use it without importing the service.
- `backend/src/capture/email-capture.ts` — the `email()` handler's body,
  moved out of the entrypoint so its provider can be injected.
- `backend/test/html-text.test.ts`
- `backend/test/attachments.test.ts`

**Modify:**
- `backend/src/capture/extraction.ts` — `ExtractionMedia`, reshaped `ExtractionInput`.
- `backend/src/capture/providers.ts` — map N media into the existing arrays.
- `backend/src/capture/capture-service.ts` — `notesSuffix`; `toBase64` moves out.
- `backend/src/capture/limits.ts` — split the one size cap into two.
- `backend/src/index.ts` — wire body text + attachments into `email()`.
- `backend/src/routes/capture.ts` — photo call site, new input shape.
- `backend/test/providers.test.ts` — new input shape + media coverage.
- `backend/test/email-handler.test.ts` — HTML and attachment cases.
- `docs/plan.md` — §8 note on what is and isn't read.

**Test command throughout:** run from `backend/`:

```bash
npx vitest run --no-file-parallelism
```

---

## Task 1: Reshape `ExtractionInput`

Foundation — everything else depends on media being expressible. Ships
green with no behaviour change.

**Files:**
- Modify: `backend/src/capture/extraction.ts:24-31`
- Modify: `backend/src/capture/providers.ts:28-36`, `:68-82`
- Modify: `backend/src/routes/capture.ts:53`
- Modify: `backend/src/index.ts:143`
- Test: `backend/test/providers.test.ts:16-20`

- [ ] **Step 1: Write the failing test** — replace the `IMAGE_INPUT` constant at
`backend/test/providers.test.ts:16-20` and add media coverage. New constants:

```ts
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
```

Append these two tests to the file:

```ts
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
    const images = parts.filter((p) => "inline_data" in p);
    expect(images).toHaveLength(2);
    const texts = parts.filter((p) => "text" in p).map((p) => p.text as string);
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
    const text = content.find((b) => b.type === "text")?.text ?? "";
    expect(text).toContain("Tasting stand Saturday");
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --no-file-parallelism test/providers.test.ts`
Expected: FAIL — type errors on the new input shape, and the media
assertions find one image, not two.

- [ ] **Step 3: Implement the type change.** Replace
`backend/src/capture/extraction.ts:24-31` with:

```ts
/** One image handed to a model alongside the text. */
export interface ExtractionMedia {
  mimeType: string;
  dataBase64: string;
}

/**
 * What a provider is asked to read.
 *
 * Text and media travel together rather than as an either/or: a
 * forwarded booking email is a body AND, often, the flyer attached to
 * it, and reading only one of them is how a draft ends up confidently
 * wrong. There is no `kind` discriminator because it would be derivable
 * from `media` and therefore able to disagree with it.
 */
export interface ExtractionInput {
  /** Body text — subject + body for email, absent for a bare photo. */
  text?: string;
  /** Photo capture sends exactly one; email capture sends zero or more. */
  media?: ExtractionMedia[];
}
```

- [ ] **Step 4: Implement the Gemini mapping.** Replace the body of
`GeminiProvider.extract`'s part assembly (`providers.ts:29-36`) with:

```ts
    const parts: Record<string, unknown>[] = [{ text: EXTRACTION_PROMPT }];
    for (const item of input.media ?? []) {
      parts.push({
        inline_data: { mime_type: item.mimeType, data: item.dataBase64 },
      });
    }
    if (input.text !== undefined && input.text !== "") {
      parts.push({ text: input.text });
    }
```

- [ ] **Step 5: Implement the Anthropic mapping.** Replace the `content`
assignment (`providers.ts:68-82`) with:

```ts
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
```

- [ ] **Step 6: Update the two call sites.**

`backend/src/routes/capture.ts:53` becomes:

```ts
        input: { media: [{ mimeType, dataBase64: toBase64(bytes) }] },
```

`backend/src/index.ts:143` becomes:

```ts
      input: { text },
```

- [ ] **Step 7: Run the full backend suite**

Run: `npx vitest run --no-file-parallelism`
Expected: PASS. The photo route and the three existing email-handler tests
must be green — this task changes no behaviour.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/capture/extraction.ts backend/src/capture/providers.ts backend/src/routes/capture.ts backend/src/index.ts backend/test/providers.test.ts
git commit -m "refactor(capture): let an extraction carry text and images together"
```

---

## Task 2: Read HTML bodies

**Files:**
- Create: `backend/src/capture/html-text.ts`
- Test: `backend/test/html-text.test.ts`

- [ ] **Step 1: Write the failing test** — create
`backend/test/html-text.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { htmlToText } from "../src/capture/html-text.ts";

describe("htmlToText", () => {
  it("keeps the prose and drops the markup", async () => {
    const text = await htmlToText(
      "<html><body><p>Costco on 5th</p><p>$150 for six hours</p></body></html>",
    );
    expect(text).toContain("Costco on 5th");
    expect(text).toContain("$150 for six hours");
    expect(text).not.toContain("<p>");
  });

  it("never treats stylesheet or script source as prose", async () => {
    // A tag-stripping regex fails exactly here, and the failure is
    // expensive: CSS is long, and it would be sent to the model as text.
    const text = await htmlToText(
      "<html><head><style>.a{color:red}</style><title>Ignore me</title></head>" +
        "<body><script>var x = 'hello';</script><p>Real body</p></body></html>",
    );
    expect(text).toBe("Real body");
  });

  it("separates block elements so words do not run together", async () => {
    const text = await htmlToText("<div>Saturday</div><div>10am</div>");
    expect(text).not.toContain("Saturday10am");
  });

  it("breaks table rows and list items apart", async () => {
    const text = await htmlToText(
      "<table><tr><td>Date</td></tr><tr><td>Sat 3rd</td></tr></table>",
    );
    expect(text).not.toContain("DateSat");
  });

  it("decodes the entities a mail client emits", async () => {
    const text = await htmlToText("<p>Ben &amp; Jerry&#39;s&nbsp;booking</p>");
    expect(text).toContain("Ben & Jerry's");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&#39;");
  });

  it("collapses the whitespace that HTML mail is padded with", async () => {
    const text = await htmlToText(
      "<p>   Lots\n\n\n   of      space   </p>\n\n\n<p>here</p>",
    );
    expect(text).toBe("Lots of space\nhere");
  });

  it("is empty for empty input rather than throwing", async () => {
    expect(await htmlToText("")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --no-file-parallelism test/html-text.test.ts`
Expected: FAIL — cannot resolve `../src/capture/html-text.ts`.

- [ ] **Step 3: Implement** — create `backend/src/capture/html-text.ts`:

```ts
/**
 * The readable text of an HTML email body.
 *
 * Booking platforms routinely send HTML-only mail. PostalMime then
 * leaves `text` empty, and extraction used to see the subject line and
 * nothing else — a draft built from six words.
 *
 * HTMLRewriter rather than a regex or a new dependency: it is the
 * runtime's own streaming parser, so it costs no bundle size and it
 * will not mistake the contents of <style> for prose the way a
 * tag-stripping regex does.
 */

/** Tags whose boundary is a line break, so words do not run together. */
const BLOCK_TAGS = new Set([
  "p", "div", "br", "tr", "li", "table", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);

/**
 * The handful of entities worth decoding by hand. Everything numeric is
 * covered generically; the named set is deliberately short because mail
 * clients emit these five and little else.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#?apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Ampersand last: decoding it first would turn "&amp;lt;" into "<".
    .replace(/&amp;/gi, "&");
}

export async function htmlToText(html: string): Promise<string> {
  if (html.trim() === "") return "";

  const out: string[] = [];
  let skipDepth = 0;

  const rewriter = new HTMLRewriter()
    .on("script, style, title", {
      element(el) {
        skipDepth += 1;
        el.onEndTag(() => {
          skipDepth -= 1;
        });
      },
    })
    .on("*", {
      element(el) {
        if (BLOCK_TAGS.has(el.tagName.toLowerCase())) out.push("\n");
      },
      text(chunk) {
        if (skipDepth === 0) out.push(chunk.text);
      },
    });

  await rewriter.transform(new Response(html)).text();

  return decodeEntities(out.join(""))
    .replace(/\r/g, "")
    .replace(/ /g, " ")
    // Horizontal whitespace only — newlines carry the block structure.
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --no-file-parallelism test/html-text.test.ts`
Expected: PASS, 7 tests.

If the entity test fails because `HTMLRewriter` already decoded the text,
delete the corresponding `.replace` from `decodeEntities` rather than
weakening the assertion — the assertion is the contract callers depend on.

- [ ] **Step 5: Commit**

```bash
git add backend/src/capture/html-text.ts backend/test/html-text.test.ts
git commit -m "feat(capture): read the text out of an HTML email body"
```

---

## Task 3: Choose which attachments are worth reading

**Files:**
- Create: `backend/src/lib/base64.ts`
- Create: `backend/src/capture/attachments.ts`
- Modify: `backend/src/capture/capture-service.ts` (remove `toBase64`)
- Modify: `backend/src/routes/capture.ts` (import moves)
- Test: `backend/test/attachments.test.ts`

- [ ] **Step 1: Move `toBase64` first.** Create `backend/src/lib/base64.ts`:

```ts
/** Chunked so a large image cannot blow the argument limit of a single
 * String.fromCharCode call. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
```

Delete the `toBase64` export from the end of
`backend/src/capture/capture-service.ts`. In
`backend/src/routes/capture.ts`, change the import to:

```ts
import { createDraftFromCapture } from "../capture/capture-service.ts";
import { toBase64 } from "../lib/base64.ts";
```

Run: `npx vitest run --no-file-parallelism` — expected PASS, unchanged behaviour.

- [ ] **Step 2: Write the failing test** — create
`backend/test/attachments.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MIN_ATTACHMENT_BYTES,
  attachmentBytes,
  selectAttachments,
} from "../src/capture/attachments.ts";

function candidate(filename: string, mimeType: string, size: number) {
  return { filename, mimeType, bytes: new Uint8Array(size).fill(7) };
}

const BIG = MIN_ATTACHMENT_BYTES * 2;

describe("selectAttachments", () => {
  it("passes a real image through as media", () => {
    const result = selectAttachments([candidate("flyer.png", "image/png", BIG)]);
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.mimeType).toBe("image/png");
    expect(result.media[0]?.dataBase64.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });

  it("names a PDF instead of reading it", () => {
    // PDFs need per-provider document blocks; until then the user must
    // be told the real document went unread.
    const result = selectAttachments([
      candidate("booking.pdf", "application/pdf", BIG),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped.join(" ")).toContain("booking.pdf");
  });

  it("drops tiny images without mentioning them", () => {
    // Signature logos and tracking pixels. Naming every one would bury
    // the note that actually matters.
    const result = selectAttachments([
      candidate("logo.png", "image/png", MIN_ATTACHMENT_BYTES - 1),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it("names an image too large to be worth reading", () => {
    const result = selectAttachments([
      candidate("huge.jpg", "image/jpeg", MAX_ATTACHMENT_BYTES + 1),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped.join(" ")).toContain("huge.jpg");
  });

  it("keeps the largest images and names the rest", () => {
    const result = selectAttachments([
      candidate("small.png", "image/png", BIG),
      candidate("largest.png", "image/png", BIG * 4),
      candidate("middle.png", "image/png", BIG * 2),
    ]);
    expect(result.media).toHaveLength(MAX_ATTACHMENTS);
    expect(result.skipped.join(" ")).toContain("small.png");
    expect(result.skipped.join(" ")).not.toContain("largest.png");
  });

  it("normalises the mime type it reports", () => {
    const result = selectAttachments([candidate("f.png", "IMAGE/PNG", BIG)]);
    expect(result.media[0]?.mimeType).toBe("image/png");
  });

  it("survives an email with no attachments", () => {
    expect(selectAttachments([])).toEqual({ media: [], skipped: [] });
  });

  it("gives an unnamed attachment a placeholder name", () => {
    const result = selectAttachments([
      { filename: null, mimeType: "application/zip", bytes: new Uint8Array(BIG) },
    ]);
    expect(result.skipped.join(" ")).toContain("attachment");
  });
});

describe("attachmentBytes", () => {
  it("reads an ArrayBuffer part", () => {
    expect(attachmentBytes({ content: new Uint8Array([1, 2, 3]).buffer })).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("reads a Uint8Array part unchanged", () => {
    expect(attachmentBytes({ content: new Uint8Array([4, 5]) })).toEqual(
      new Uint8Array([4, 5]),
    );
  });

  it("decodes a base64 string part", () => {
    // Getting this wrong yields a byte length that passes the size
    // filters and an image the model cannot read.
    expect(
      attachmentBytes({ content: "aGVsbG8=", encoding: "base64" }),
    ).toEqual(new TextEncoder().encode("hello"));
  });

  it("treats an unlabelled string part as utf8", () => {
    expect(attachmentBytes({ content: "hi" })).toEqual(
      new TextEncoder().encode("hi"),
    );
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run --no-file-parallelism test/attachments.test.ts`
Expected: FAIL — cannot resolve `../src/capture/attachments.ts`.

- [ ] **Step 4: Implement** — create `backend/src/capture/attachments.ts`:

```ts
/**
 * Which attachments are worth paying a model to look at.
 *
 * Every rule here exists to spend the extraction budget on the one
 * thing that is usually the actual booking — a flyer or a screenshot —
 * and not on the signature logo underneath it.
 *
 * Images only. PDFs would need a document block whose shape differs
 * between Gemini and Anthropic, which would push provider knowledge
 * back into the call site that providers.ts deliberately keeps clean.
 * They are named in `skipped` instead, so the user knows to open the
 * original.
 */
import { toBase64 } from "../lib/base64.ts";
import type { ExtractionMedia } from "./extraction.ts";

/** What both providers encode identically today. */
export const EXTRACTABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Below this, an image is decoration: a logo, a spacer, a pixel. */
export const MIN_ATTACHMENT_BYTES = 8 * 1024;

/** Above this, we decline to pay to look at it. */
export const MAX_ATTACHMENT_BYTES = 1_500_000;

/** How many images one email may spend on extraction. */
export const MAX_ATTACHMENTS = 2;

export interface CandidateAttachment {
  filename: string | null;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AttachmentSelection {
  media: ExtractionMedia[];
  /** Phrases naming what went unread, for the draft note. Empty when
   * nothing was skipped that a user would care about. */
  skipped: string[];
}

/** postal-mime hands back one of three representations. */
export function attachmentBytes(part: {
  content: ArrayBuffer | Uint8Array | string;
  encoding?: "base64" | "utf8";
}): Uint8Array {
  const { content } = part;
  if (typeof content === "string") {
    return part.encoding === "base64"
      ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0))
      : new TextEncoder().encode(content);
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function selectAttachments(
  candidates: CandidateAttachment[],
): AttachmentSelection {
  const skipped: string[] = [];
  const usable: CandidateAttachment[] = [];

  for (const candidate of candidates) {
    const name = candidate.filename ?? "attachment";
    const mimeType = candidate.mimeType.toLowerCase();

    if (!EXTRACTABLE_IMAGE_TYPES.has(mimeType)) {
      skipped.push(`${name} (${mimeType})`);
      continue;
    }
    // Deliberately unnamed: a note listing four tracking pixels is
    // noise, and hides the PDF that matters.
    if (candidate.bytes.length < MIN_ATTACHMENT_BYTES) continue;
    if (candidate.bytes.length > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${name} (too large to read)`);
      continue;
    }
    usable.push(candidate);
  }

  // Largest first: with room for only a couple, the biggest image is
  // the best available guess at which one is the actual document.
  usable.sort((a, b) => b.bytes.length - a.bytes.length);

  for (const extra of usable.slice(MAX_ATTACHMENTS)) {
    skipped.push(`${extra.filename ?? "attachment"} (not read)`);
  }

  return {
    media: usable.slice(0, MAX_ATTACHMENTS).map((candidate) => ({
      mimeType: candidate.mimeType.toLowerCase(),
      dataBase64: toBase64(candidate.bytes),
    })),
    skipped,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --no-file-parallelism test/attachments.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/base64.ts backend/src/capture/attachments.ts backend/src/capture/capture-service.ts backend/src/routes/capture.ts backend/test/attachments.test.ts
git commit -m "feat(capture): pick the attachments worth extracting from"
```

---

## Task 4: Say what was not read

**Files:**
- Modify: `backend/src/capture/capture-service.ts`
- Test: `backend/test/capture.test.ts`

- [ ] **Step 1: Write the failing test** — append to
`backend/test/capture.test.ts`, inside its top-level `describe`:

```ts
  it("appends a notes suffix to what the model returned", async () => {
    // Without this, a draft extracted from body text alone looks
    // complete while the PDF that held the real booking went unread.
    const provider = {
      extract: async () => ({
        kind: "gig" as const,
        clientName: "Acme",
        notes: "Six hour shift",
      }),
    };

    const draft = await createDraftFromCapture(env, U1, {
      source: "email",
      rawBytes: new Uint8Array([1, 2, 3]),
      rawContentType: "message/rfc822",
      provider,
      input: { text: "whatever" },
      notesSuffix: "Not read: booking.pdf (application/pdf).",
    });

    expect(draft).not.toBe("extraction-failed");
    const extracted = JSON.parse(
      (draft as Exclude<typeof draft, "extraction-failed">).extractedJson,
    ) as { notes: string };
    expect(extracted.notes).toContain("Six hour shift");
    expect(extracted.notes).toContain("booking.pdf");
  });

  it("uses the suffix as the whole note when the model returned none", async () => {
    const provider = {
      extract: async () => ({ kind: "gig" as const, clientName: "Acme" }),
    };

    const draft = await createDraftFromCapture(env, U1, {
      source: "email",
      rawBytes: new Uint8Array([1, 2, 3]),
      rawContentType: "message/rfc822",
      provider,
      input: { text: "whatever" },
      notesSuffix: "Not read: booking.pdf (application/pdf).",
    });

    const extracted = JSON.parse(
      (draft as Exclude<typeof draft, "extraction-failed">).extractedJson,
    ) as { notes: string };
    expect(extracted.notes).toBe("Not read: booking.pdf (application/pdf).");
  });
```

If `createDraftFromCapture`, `env` or `U1` are not already imported in that
file, match the imports the existing tests there use.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --no-file-parallelism test/capture.test.ts`
Expected: FAIL — `notesSuffix` is not a known property, and the note is
unchanged.

- [ ] **Step 3: Implement.** Add to the `CaptureRequest` interface in
`backend/src/capture/capture-service.ts`:

```ts
  /** Appended to the extracted notes: what this capture could not read
   * (a PDF, an oversize image). A draft built from body text alone
   * looks complete, so the omission has to be stated on the draft
   * itself — the raw email is one tap away but nothing would prompt
   * the user to go and look. */
  notesSuffix?: string;
```

Then, in `createDraftFromCapture`, immediately after the client-match block
and before `const draftId = crypto.randomUUID();`:

```ts
  if (request.notesSuffix !== undefined && request.notesSuffix !== "") {
    extracted = {
      ...extracted,
      notes:
        extracted.notes != null && extracted.notes !== ""
          ? `${extracted.notes}\n\n${request.notesSuffix}`
          : request.notesSuffix,
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --no-file-parallelism test/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/capture/capture-service.ts backend/test/capture.test.ts
git commit -m "feat(capture): name on the draft what the capture could not read"
```

---

## Task 5: Split the size cap

**Files:**
- Modify: `backend/src/capture/limits.ts:16-22`

- [ ] **Step 1: Implement.** Replace the `MAX_EMAIL_BYTES` block with:

```ts
/**
 * The largest message we will accept at all.
 *
 * This bounds R2 storage and parse cost — nothing more. It used to do
 * a second job as well, capping what reached the model, which only
 * worked while the handler read plain text and no attachment could
 * ever fit. A single phone photo is over 256KB, so that ceiling
 * rejected exactly the mail this feature is for. What we pay a model
 * to read is now bounded separately, by MAX_EXTRACT_TEXT_CHARS and by
 * the per-attachment and count caps in attachments.ts.
 */
export const MAX_EMAIL_BYTES = 3 * 1024 * 1024;

/**
 * The most body text sent for extraction. A forwarded thread can be
 * enormous, and the booking is always near the top.
 */
export const MAX_EXTRACT_TEXT_CHARS = 12_000;
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run --no-file-parallelism`
Expected: PASS — nothing consumes `MAX_EXTRACT_TEXT_CHARS` yet.

- [ ] **Step 3: Commit**

```bash
git add backend/src/capture/limits.ts
git commit -m "refactor(capture): give the message cap one job, not two"
```

---

## Task 6: Extract the handler so what it reads is observable

The logic currently lives inline in `index.ts`'s `email()`, which calls
`providerFromEnv` directly. That makes the new behaviour untestable: the
stub provider returns canned data whatever it is given, so no assertion on
the draft can show whether the HTML body was ever parsed. Moving the body
into a module with an injected provider — the pattern `makeCaptureRouter`
already uses — is what makes Task 6's tests mean anything.

**Files:**
- Create: `backend/src/capture/email-capture.ts`
- Modify: `backend/src/index.ts:102-158` (becomes a one-line delegation)
- Test: `backend/test/email-handler.test.ts`

- [ ] **Step 1: Move the handler, unchanged, into a module.** Create
`backend/src/capture/email-capture.ts`, cutting the body of `email()` out of
`index.ts` verbatim for now (HTML and attachments arrive in Step 4):

```ts
/**
 * Turning a forwarded email into a draft.
 *
 * Lives here rather than in the Worker entrypoint so the provider can be
 * injected: with `providerFromEnv` wired in directly, a test could only
 * ever see the stub's canned answer, and nothing could show whether the
 * message was actually read.
 */
import PostalMime from "postal-mime";
import type { Bindings } from "../env.ts";
import { log } from "../logger.ts";
import { UsersRepo } from "../repos/users.ts";
import { userIdFromAddress } from "./address.ts";
import { createDraftFromCapture } from "./capture-service.ts";
import type { ExtractionProvider } from "./extraction.ts";
import { hasCaptureBudget, MAX_EMAIL_BYTES } from "./limits.ts";
import { providerFromEnv } from "./providers.ts";

/** Just the parts of ForwardableEmailMessage this needs — so a test can
 * build one without the whole runtime type. */
export interface CapturedMessage {
  to: string;
  raw: ReadableStream;
  setReject(reason: string): void;
}

export async function handleCapturedEmail(
  message: CapturedMessage,
  env: Bindings,
  providerFactory: (env: Bindings) => ExtractionProvider = providerFromEnv,
): Promise<void> {
  const userId = userIdFromAddress(message.to);
  if (userId === null) {
    message.setReject("Unknown recipient");
    return;
  }
  const user = await UsersRepo.for(env.DB).get(userId);
  if (user === null) {
    message.setReject("Unknown recipient");
    return;
  }

  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());

  // Too big to be a booking email. Rejected at the edge rather than
  // stored, because the point of the cap is to not pay to read it.
  if (rawBytes.length > MAX_EMAIL_BYTES) {
    message.setReject("Message too large");
    log.warn("email capture rejected: too large", {
      userId: user.id,
      bytes: rawBytes.length,
    });
    return;
  }

  const parsed = await PostalMime.parse(rawBytes);
  const text = [parsed.subject ?? "", parsed.text ?? ""].join("\n\n").trim();

  // Out of budget: still keep the mail, just do not pay to read it.
  // Rejecting here would lose someone's booking to a quota they cannot
  // see, which is the one outcome worse than an unparsed draft.
  const withinBudget = await hasCaptureBudget(env, user.id);
  const provider = withinBudget
    ? providerFactory(env)
    : { extract: async () => null };

  const result = await createDraftFromCapture(env, user.id, {
    source: "email",
    rawBytes,
    rawContentType: "message/rfc822",
    provider,
    input: { text },
    // Never silently drop a user's mail: a failed extraction still
    // yields a reviewable draft pointing at the original.
    fallbackExtracted: {
      kind: "unknown",
      notes: withinBudget
        ? "Extraction failed — open the original email below."
        : "Daily capture limit reached — this was saved unread. Open the original email below.",
    },
  });
  if (result === "extraction-failed") {
    log.warn("email capture failed", { userId: user.id });
  } else {
    log.info("email captured", { userId: user.id, draftId: result.id });
  }
}
```

In `backend/src/index.ts`, replace the whole `email()` body with:

```ts
  // Email capture (docs/plan.md §8): Cloudflare Email Routing delivers
  // each user's forwarding address u-<userId>@<domain> here. Activation
  // is dashboard-side once a domain with Email Routing exists — the
  // handler itself is live.
  async email(message, env, _ctx) {
    await handleCapturedEmail(message, env);
  },
```

and its import block: delete the now-unused `PostalMime`, `UsersRepo`,
`providerFromEnv`, `createDraftFromCapture`, `userIdFromAddress`,
`hasCaptureBudget` and `MAX_EMAIL_BYTES` imports **only if nothing else in
`index.ts` uses them** — check each with a search before removing — and add:

```ts
import { handleCapturedEmail } from "./capture/email-capture.ts";
```

- [ ] **Step 2: Run the suite to prove the move changed nothing**

Run: `npx vitest run --no-file-parallelism test/email-handler.test.ts`
Expected: PASS, the existing 3 tests, untouched.

- [ ] **Step 3: Commit the move on its own**

```bash
git add backend/src/capture/email-capture.ts backend/src/index.ts
git commit -m "refactor(capture): move email handling out of the entrypoint"
```

- [ ] **Step 4: Write the failing test** — in
`backend/test/email-handler.test.ts`, add these builders below the existing
`makeMessage`:

```ts
/** Wraps base64 at 76 columns the way a mail client does — some
 * parsers reject a single enormous line. */
function b64Body(text: string): string {
  return btoa(text).match(/.{1,76}/g)!.join("\r\n");
}

function htmlEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Booking confirmed",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><style>.x{color:red}</style>" +
        "<p>Costco on 5th</p><p>$150 for the 6-hour shift</p></body></html>",
      "",
    ].join("\r\n"),
  );
}

/** One PNG attachment, comfortably over MIN_ATTACHMENT_BYTES. */
function imageEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Flyer attached",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Flyer attached for Saturday.",
      "",
      "--b1",
      'Content-Type: image/png; name="flyer.png"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="flyer.png"',
      "",
      b64Body("\x89PNG\r\n\x1a\n" + "x".repeat(12000)),
      "",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

/** One PDF attachment — the case that must be named, not read. */
function pdfEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Booking attached",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Details are in the attachment.",
      "",
      "--b1",
      'Content-Type: application/pdf; name="booking.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="booking.pdf"',
      "",
      b64Body("not really a pdf, but big enough".repeat(400)),
      "",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

function messageFrom(bytes: Uint8Array, to: string) {
  return {
    from: "booker@agency.example",
    to,
    rawSize: bytes.length,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
}

/**
 * Records what extraction was actually asked to read.
 *
 * The whole point of these tests: the stub provider answers the same
 * thing whatever it is handed, so asserting on the resulting draft
 * cannot distinguish "read the HTML body" from "read nothing".
 */
function recordingProvider() {
  const seen: ExtractionInput[] = [];
  return {
    seen,
    factory: () => ({
      extract: async (input: ExtractionInput) => {
        seen.push(input);
        return { kind: "gig" as const, clientName: "Acme" };
      },
    }),
  };
}
```

Add these imports to the top of the file:

```ts
import { handleCapturedEmail } from "../src/capture/email-capture.ts";
import type { ExtractionInput } from "../src/capture/extraction.ts";
```

Then add these tests inside the existing `describe`:

```ts
  it("reads the body of an HTML-only email, not just the subject", async () => {
    // The common shape for a booking platform's confirmation. Before
    // this, extraction saw the subject line and nothing else.
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(htmlEmail(to), to),
      env,
      recorder.factory,
    );

    expect(recorder.seen).toHaveLength(1);
    const text = recorder.seen[0]?.text ?? "";
    expect(text).toContain("Costco on 5th");
    expect(text).toContain("$150 for the 6-hour shift");
    // Never pay to send a stylesheet to a model as prose.
    expect(text).not.toContain("color:red");
  });

  it("sends an image attachment alongside the body", async () => {
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(imageEmail(to), to),
      env,
      recorder.factory,
    );

    const input = recorder.seen[0];
    expect(input?.media ?? []).toHaveLength(1);
    expect(input?.media?.[0]?.mimeType).toBe("image/png");
    expect(input?.text ?? "").toContain("Flyer attached for Saturday");
  });

  it("names a PDF on the draft instead of reading it", async () => {
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(pdfEmail(to), to),
      env,
      recorder.factory,
    );

    expect(recorder.seen[0]?.media ?? []).toHaveLength(0);

    // Any draft, not a positional one: other tests in this file have
    // already inserted drafts for this user and list order is not part
    // of the repo's contract.
    const drafts = await DraftsRepo.for(env.DB).list(U1, "pending");
    const named = drafts.some((draft) =>
      ((JSON.parse(draft.extractedJson) as { notes?: string }).notes ?? "")
        .includes("booking.pdf"),
    );
    expect(named).toBe(true);
  });
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run --no-file-parallelism test/email-handler.test.ts`
Expected: FAIL — the HTML body never reaches the provider, no media is
sent, and the PDF is never named.

- [ ] **Step 6: Implement.** In `backend/src/capture/email-capture.ts`, add
to the imports:

```ts
import { attachmentBytes, selectAttachments } from "./attachments.ts";
import { htmlToText } from "./html-text.ts";
```

and extend the existing `limits.ts` import with `MAX_EXTRACT_TEXT_CHARS`
(merge the name into that line — do not add a second import from the same
module).

Replace the single body-parsing line with:

```ts
  const parsed = await PostalMime.parse(rawBytes);

  // Prefer the plain-text part; fall back to the HTML one, which is all
  // a booking platform usually sends.
  const plain = (parsed.text ?? "").trim();
  const body = plain !== "" ? plain : await htmlToText(parsed.html ?? "");
  const text = [parsed.subject ?? "", body]
    .join("\n\n")
    .trim()
    .slice(0, MAX_EXTRACT_TEXT_CHARS);

  const selection = selectAttachments(
    parsed.attachments.map((part) => ({
      filename: part.filename,
      mimeType: part.mimeType,
      bytes: attachmentBytes(part),
    })),
  );
```

Then change the `createDraftFromCapture` call's `input` and add
`notesSuffix` beside it:

```ts
    input: { text, media: selection.media },
    notesSuffix:
      selection.skipped.length > 0
        ? `Not read: ${selection.skipped.join("; ")}. Open the original email below.`
        : undefined,
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run --no-file-parallelism test/email-handler.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the whole backend suite and typecheck**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit -p tsconfig.json
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add backend/src/capture/email-capture.ts backend/test/email-handler.test.ts
git commit -m "feat(capture): read HTML bodies and image attachments from forwarded mail"
```

---

## Task 7: Update the docs

**Files:**
- Modify: `docs/plan.md` §8

- [ ] **Step 1:** In `docs/plan.md` §8, replace the Email Workers bullet's
parenthetical about parsing with:

```markdown
- Cloudflare **Email Workers**: per-user forwarding address
  (`u-<token>@<domain>`), `email()` handler parses the body — plain text,
  or the HTML part reduced to text — plus up to two image attachments.
  PDFs are named on the draft rather than read: the two providers need
  different document blocks, so supporting them would push provider
  knowledge back into the call site. Prereq: a zone with Email Routing
  enabled (open item — domain TBD).
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan.md
git commit -m "docs: say what email capture reads, and what it only names"
```

---

## Self-review notes

- **Spec coverage.** §1 → Task 1. §2 → Task 2. §3 → Task 3. §4 → Tasks 3+5.
  §5 → Tasks 4+6. §6 → Task 1. §7 → tests in every task.
- **Deliberate omissions.** PDFs are not sent to a model (design decision,
  named on the draft instead). The webapp is untouched — the draft review
  screen already renders `notes` and links the raw email.
- **Ordering.** Task 1 ships green and unblocks the rest; Task 5 lands the
  constant one task before Task 6 consumes it, so no task depends on a
  later one.
- **Why Task 6 starts with a pure move.** The first draft of this plan
  asserted that the raw email stored in R2 contained the HTML body text —
  which is true whether or not `htmlToText` is ever called, so the test
  proved nothing. The handler could not be tested properly because it
  resolved its own provider, and the stub answers identically no matter
  what it is handed. Moving the body into `email-capture.ts` with an
  injected factory is what makes the Task 6 assertions real; the move is
  committed separately so a regression in it is not tangled with the
  feature.
