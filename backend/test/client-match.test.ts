/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  matchClient,
  INITIALS_CONFIDENCE,
  CONTAINMENT_CONFIDENCE,
  MATCH_THRESHOLD,
} from "../src/capture/client-match.ts";

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

// The tiers the 2026-09-19 client-create-and-match design adds between
// the exact check and the Dice fallback. Both sit below the review
// screen's 0.9 "confident" band on purpose: the screen must ASK
// "Is this X?" for an initials or longer/shorter-form hit, never link
// it silently.
describe("matchClient (initials and containment tiers)", () => {
  const FFA = [{ id: "ffa", name: "Full Field Agency" }];

  it("exports both tier confidences below the 0.9 confident band", () => {
    expect(INITIALS_CONFIDENCE).toBe(0.75);
    expect(CONTAINMENT_CONFIDENCE).toBe(0.8);
    expect(INITIALS_CONFIDENCE).toBeLessThan(0.9);
    expect(CONTAINMENT_CONFIDENCE).toBeLessThan(0.9);
    expect(MATCH_THRESHOLD).toBe(0.6);
  });

  it("matches initials from the flyer against the stored full name", () => {
    const m = matchClient("FFA", FFA);
    expect(m?.clientId).toBe("ffa");
    expect(m?.matchedName).toBe("Full Field Agency");
    expect(m?.confidence).toBe(INITIALS_CONFIDENCE);
  });

  it("matches the other way: client stored as initials, flyer spells it out", () => {
    const m = matchClient("Full Field Agency", [{ id: "s", name: "FFA" }]);
    expect(m?.clientId).toBe("s");
    expect(m?.confidence).toBe(INITIALS_CONFIDENCE);
  });

  it("matches punctuated initials (F.F.A. normalises to one-letter words)", () => {
    const m = matchClient("F.F.A.", FFA);
    expect(m?.clientId).toBe("ffa");
    expect(m?.confidence).toBe(INITIALS_CONFIDENCE);
  });

  it("refuses one-letter initials (\"A\" is noise, not Acme)", () => {
    expect(matchClient("A", [{ id: "a", name: "Acme" }])).toBeNull();
    expect(matchClient("Acme", [{ id: "a", name: "A" }])).toBeNull();
  });

  it("does not read a multi-word name as initials of a longer one", () => {
    // "Full Field" is not "FF": only a single word or a run of one-letter
    // words counts as an initials string.
    const m = matchClient("Full Field", [{ id: "x", name: "Fast Freight" }]);
    expect(m).toBeNull();
  });

  it("matches containment, shorter flyer name inside the stored name", () => {
    const m = matchClient("Acme", CLIENTS);
    expect(m?.clientId).toBe("c1");
    expect(m?.confidence).toBe(CONTAINMENT_CONFIDENCE);
  });

  it("matches containment, longer flyer name around the stored name", () => {
    const m = matchClient("Acme Staffing LLC", CLIENTS);
    expect(m?.clientId).toBe("c1");
    expect(m?.confidence).toBe(CONTAINMENT_CONFIDENCE);
  });

  it("matches containment as a word subset, not only a prefix", () => {
    const m = matchClient("Roadshow Team", CLIENTS);
    expect(m?.clientId).toBe("c3");
    expect(m?.confidence).toBe(CONTAINMENT_CONFIDENCE);
  });

  it("prefers a containment hit over a weaker Dice match on another candidate", () => {
    // "Costco Road Crew" shares enough bigrams with "Costco Roadshow" to
    // clear the Dice threshold but not to reach 0.8; the whole-word
    // containment on the Team client must still win, whatever the order.
    const diceOnly = [{ id: "crew", name: "Costco Road Crew" }];
    const dice = matchClient("Costco Roadshow", diceOnly);
    expect(dice?.clientId).toBe("crew");
    expect(dice?.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(dice?.confidence).toBeLessThan(CONTAINMENT_CONFIDENCE);

    const m = matchClient("Costco Roadshow", [
      ...diceOnly,
      { id: "c3", name: "Costco Roadshow Team" },
    ]);
    expect(m?.clientId).toBe("c3");
    expect(m?.confidence).toBe(CONTAINMENT_CONFIDENCE);
  });

  it("scores a case-only difference as an exact 1.0, not containment", () => {
    const m = matchClient("acme staffing", CLIENTS);
    expect(m?.clientId).toBe("c1");
    expect(m?.confidence).toBe(1);
  });

  it("still returns null for a wholly different name", () => {
    expect(matchClient("Zeta Logistics", [...CLIENTS, ...FFA])).toBeNull();
  });
});
