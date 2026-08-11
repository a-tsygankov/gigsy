/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Who may sign in.
 *
 * The rules are small and the consequences are not: too loose and the
 * deployment is open to every Google account, too strict and the owner
 * cannot get into their own app.
 */
import { describe, it, expect } from "vitest";
import { isAllowedEmail, parseAllowlist } from "../src/auth/allowlist.ts";

describe("parseAllowlist", () => {
  it("splits, trims and lowercases", () => {
    expect(parseAllowlist(" A@x.com , B@Y.com ")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("ignores empty entries from a trailing comma", () => {
    expect(parseAllowlist("a@x.com,,")).toEqual(["a@x.com"]);
  });

  it("treats unset and blank as no list", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("   ")).toEqual([]);
  });
});

describe("isAllowedEmail", () => {
  it("allows everyone when no list is configured", () => {
    // The behaviour that already shipped. Defaulting to deny would lock
    // the owner out the first time they forgot to set it.
    expect(isAllowedEmail("anyone@example.com", undefined)).toBe(true);
    expect(isAllowedEmail("anyone@example.com", "")).toBe(true);
  });

  it("allows a listed address", () => {
    expect(isAllowedEmail("her@example.com", "him@example.com,her@example.com")).toBe(
      true,
    );
  });

  it("refuses an address that is not on the list", () => {
    expect(isAllowedEmail("stranger@example.com", "him@example.com")).toBe(false);
  });

  it("ignores case on both sides", () => {
    // Google hands back whatever case the account uses; a list typed by
    // hand will not match it.
    expect(isAllowedEmail("HER@Example.COM", "her@example.com")).toBe(true);
    expect(isAllowedEmail("her@example.com", "HER@EXAMPLE.COM")).toBe(true);
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(isAllowedEmail("  her@example.com ", " her@example.com ")).toBe(true);
  });

  it("does not match a domain fragment", () => {
    // "@example.com" as an entry would look like a restriction and
    // behave like none, so entries are whole addresses only.
    expect(isAllowedEmail("stranger@example.com", "@example.com")).toBe(false);
    expect(isAllowedEmail("stranger@example.com", "example.com")).toBe(false);
  });

  it("does not match a prefix of a listed address", () => {
    expect(isAllowedEmail("her@example.com.evil.test", "her@example.com")).toBe(false);
  });
});
