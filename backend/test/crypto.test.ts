/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { decryptString, encryptString } from "../src/auth/crypto.ts";

// 32 bytes, base64 — same shape as the REFRESH_TOKEN_ENC_KEY secret.
const KEY = btoa("0123456789abcdef0123456789abcdef");
const OTHER_KEY = btoa("fedcba9876543210fedcba9876543210");

describe("AES-GCM string encryption", () => {
  it("round-trips a plaintext", async () => {
    const blob = await encryptString("google-refresh-token-xyz", KEY);
    expect(blob).not.toContain("google-refresh-token");
    expect(await decryptString(blob, KEY)).toBe("google-refresh-token-xyz");
  });

  it("returns null when decrypting with the wrong key", async () => {
    const blob = await encryptString("secret", KEY);
    expect(await decryptString(blob, OTHER_KEY)).toBeNull();
  });

  it("returns null on tampered ciphertext", async () => {
    const blob = await encryptString("secret", KEY);
    const bytes = Uint8Array.from(atob(blob), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    expect(await decryptString(tampered, KEY)).toBeNull();
  });

  it("returns null on garbage input", async () => {
    expect(await decryptString("not-base64!!!", KEY)).toBeNull();
  });

  it("uses a fresh IV per encryption (same plaintext → different blobs)", async () => {
    const a = await encryptString("same", KEY);
    const b = await encryptString("same", KEY);
    expect(a).not.toBe(b);
  });
});
