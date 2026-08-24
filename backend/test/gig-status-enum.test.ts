/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The gig lifecycle is declared twice — once for the server
 * (db/schema.ts) and once for the client (webapp/src/lib/types.ts) —
 * because the two packages share no code. Nothing makes them agree.
 *
 * They must. The server's zod validation rejects what is not in its
 * list, and the client's status filter and pill are built from its own,
 * so a value in one and not the other is either a status you can set
 * and never see, or one you can pick and never save.
 *
 * This test is worth more than either list.
 */
import { describe, it, expect } from "vitest";
import { GIG_STATUSES as SERVER_STATUSES } from "../src/db/schema.ts";
import { GIG_STATUSES as CLIENT_STATUSES } from "../../webapp/src/lib/types.ts";

describe("gig status enum", () => {
  it("is declared identically on both sides", () => {
    expect([...CLIENT_STATUSES]).toEqual([...SERVER_STATUSES]);
  });

  it("includes delivered, between completed and cancelled", () => {
    expect([...SERVER_STATUSES]).toEqual([
      "lead",
      "confirmed",
      "completed",
      "delivered",
      "cancelled",
    ]);
  });

  it("does not include paid, which is derived (migration 0015)", () => {
    expect(SERVER_STATUSES).not.toContain("paid");
  });
});
