/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The per-user capture address.
 *
 * One side builds it for the Settings screen, the other parses it off
 * an inbound message. They have to agree exactly, because a mismatch
 * is mail that bounces with no clue why — so both live here.
 */
import { describe, it, expect } from "vitest";
import { captureAddressFor, userIdFromAddress } from "../src/capture/address.ts";

describe("captureAddressFor", () => {
  it("builds the address for a user", () => {
    expect(captureAddressFor("abc-123", "gigsy.app")).toBe("u-abc-123@gigsy.app");
  });

  it("is null when no domain is configured, rather than inventing one", () => {
    // A half-built address shown to a user is worse than none: they
    // will try it, and the mail will bounce.
    expect(captureAddressFor("abc-123", undefined)).toBeNull();
    expect(captureAddressFor("abc-123", "")).toBeNull();
    expect(captureAddressFor("abc-123", "   ")).toBeNull();
  });

  it("tolerates a domain with stray whitespace from config", () => {
    expect(captureAddressFor("abc-123", " gigsy.app ")).toBe("u-abc-123@gigsy.app");
  });
});

describe("userIdFromAddress", () => {
  it("reads the user id back out", () => {
    expect(userIdFromAddress("u-abc-123@gigsy.app")).toBe("abc-123");
  });

  it("round-trips whatever captureAddressFor built", () => {
    const id = "3f9a1c22-0000-4000-8000-abcdefabcdef";
    expect(userIdFromAddress(captureAddressFor(id, "gigsy.app")!)).toBe(id);
  });

  it("is case-insensitive, because mail servers do not preserve case", () => {
    expect(userIdFromAddress("U-ABC-123@gigsy.app")).toBe("abc-123");
  });

  it("refuses anything not in the u- form", () => {
    expect(userIdFromAddress("hello@gigsy.app")).toBeNull();
    expect(userIdFromAddress("u-@gigsy.app")).toBeNull();
    expect(userIdFromAddress("")).toBeNull();
    expect(userIdFromAddress("@gigsy.app")).toBeNull();
  });

  it("does not care which domain delivered it", () => {
    // Email Routing is configured with a catch-all, so the domain has
    // already been decided upstream; re-checking it here would only
    // add a second place to keep in step.
    expect(userIdFromAddress("u-abc@anything.test")).toBe("abc");
  });
});
