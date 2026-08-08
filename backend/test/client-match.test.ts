/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { matchClient } from "../src/capture/client-match.ts";

const CLIENTS = [
  { id: "c1", name: "Acme Staffing" },
  { id: "c2", name: "Bravo Events" },
  { id: "c3", name: "Costco Roadshow Team" },
];

describe("matchClient (fuzzy, threshold pins the handoff's open item)", () => {
  it("matches exactly after normalization (case, punctuation, spacing)", () => {
    const m = matchClient("  ACME   Staffing. ", CLIENTS);
    expect(m?.clientId).toBe("c1");
    expect(m?.confidence).toBe(1);
  });

  it("matches close variants via bigram similarity", () => {
    const m = matchClient("Acme Staffing LLC", CLIENTS);
    expect(m?.clientId).toBe("c1");
    expect(m?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("does NOT silently merge distinct clients", () => {
    expect(matchClient("Delta Promotions", CLIENTS)).toBeNull();
  });

  it("picks the best match among several candidates", () => {
    const m = matchClient("Costco Roadshow", CLIENTS);
    expect(m?.clientId).toBe("c3");
  });

  it("returns null against an empty client list", () => {
    expect(matchClient("Acme Staffing", [])).toBeNull();
  });
});
