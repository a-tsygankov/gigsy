/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";

const U1 = "user-1";

function mimeEmail(to: string): Uint8Array {
  const raw = [
    "From: booker@agency.example",
    `To: ${to}`,
    "Subject: Tasting stand this Saturday",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Costco on 5th, $150 for the 6-hour shift. Confirm by Friday.",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(raw);
}

function makeMessage(to: string) {
  const bytes = mimeEmail(to);
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

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("email() capture handler", () => {
  it("creates a pending draft for a known u-<userId> recipient", async () => {
    const message = makeMessage(`u-${U1}@gigs.example.com`);
    await worker.email!(message as never, env, createExecutionContext());

    expect(message.setReject).not.toHaveBeenCalled();
    const drafts = await DraftsRepo.for(env.DB).list(U1, "pending");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toBe("email");
    expect(drafts[0]?.rawR2Key).toContain(`u/${U1}/captures/`);
    const extracted = JSON.parse(drafts[0]!.extractedJson) as { kind: string };
    expect(extracted.kind).toBe("gig");

    // Raw email is retrievable for the review screen.
    const object = await env.RECEIPTS.get(drafts[0]!.rawR2Key!);
    expect(object).not.toBeNull();
    await object!.arrayBuffer();
  });

  it("rejects mail for unknown users without creating anything", async () => {
    const message = makeMessage("u-nobody-here@gigs.example.com");
    await worker.email!(message as never, env, createExecutionContext());

    expect(message.setReject).toHaveBeenCalled();
  });

  it("rejects addresses that are not u-<id> shaped", async () => {
    const message = makeMessage("info@gigs.example.com");
    await worker.email!(message as never, env, createExecutionContext());
    expect(message.setReject).toHaveBeenCalled();
  });
});
