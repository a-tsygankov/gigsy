/**
 * What a gig is called on screen.
 *
 * One rule, one place: the list and the detail screen must agree, and
 * duplicating "title, else notes, else client" in two components is how
 * they stop agreeing.
 */
import { describe, it, expect } from "vitest";
import { gigDisplayTitle } from "./gig-title.ts";

const base = { title: null, notes: null };

describe("gigDisplayTitle", () => {
  it("uses the title when there is one", () => {
    expect(gigDisplayTitle({ ...base, title: "Costco tasting" }, "Acme")).toBe(
      "Costco tasting",
    );
  });

  it("falls back to the first non-empty line of notes", () => {
    expect(
      gigDisplayTitle({ ...base, notes: "Booth 12 setup\nBring the banner" }, "Acme"),
    ).toBe("Booth 12 setup");
  });

  it("skips blank leading lines rather than showing nothing", () => {
    expect(gigDisplayTitle({ ...base, notes: "\n\n  Real line" }, "Acme")).toBe(
      "Real line",
    );
  });

  it("falls back to the client when there is neither", () => {
    expect(gigDisplayTitle(base, "Acme")).toBe("Acme");
  });

  it("says No client when there is nothing at all", () => {
    expect(gigDisplayTitle(base, null)).toBe("No client");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(gigDisplayTitle({ ...base, title: "   " }, "Acme")).toBe("Acme");
  });

  it("shortens a notes line long enough to swamp the row", () => {
    const long = "x".repeat(200);
    const shown = gigDisplayTitle({ ...base, notes: long }, "Acme");
    expect(shown.length).toBeLessThanOrEqual(80);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("does not shorten a long explicit title", () => {
    // The user typed it deliberately; notes are prose that happens to
    // be first, which is a different thing.
    const long = "y".repeat(120);
    expect(gigDisplayTitle({ ...base, title: long }, "Acme")).toBe(long);
  });
});
