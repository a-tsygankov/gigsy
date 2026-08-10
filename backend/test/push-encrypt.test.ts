/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { encryptPayload } from "../src/push/encrypt.ts";

/**
 * RFC 8291 §5 publishes a complete worked example — plaintext, both
 * key pairs, the salt, and the exact expected output. Reproducing it
 * byte-for-byte is the only way to know this is right without a real
 * device on the other end, so it is the anchor of this file.
 */
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  p256dh:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivateD: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("encryptPayload (RFC 8291)", () => {
  it("reproduces the RFC 8291 §5 test vector exactly", async () => {
    const body = await encryptPayload(
      VECTOR.plaintext,
      { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
      {
        salt: b64urlToBytes(VECTOR.salt),
        ephemeral: {
          publicKey: b64urlToBytes(VECTOR.asPublic),
          privateKeyD: VECTOR.asPrivateD,
        },
      },
    );

    expect(bytesToB64url(body)).toBe(VECTOR.expected);
  });

  it("frames the header as salt ‖ record size ‖ key length ‖ public key", async () => {
    const body = await encryptPayload(
      "hello",
      { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
      {
        salt: b64urlToBytes(VECTOR.salt),
        ephemeral: {
          publicKey: b64urlToBytes(VECTOR.asPublic),
          privateKeyD: VECTOR.asPrivateD,
        },
      },
    );

    expect([...body.slice(0, 16)]).toEqual([...b64urlToBytes(VECTOR.salt)]);
    // Record size 4096, big-endian.
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect([...body.slice(21, 86)]).toEqual([...b64urlToBytes(VECTOR.asPublic)]);
  });

  // Reusing a salt or ephemeral key across messages would leak far
  // more than it looks — the default path must never be deterministic.
  it("produces different ciphertext each time for identical input", async () => {
    const keys = { p256dh: VECTOR.p256dh, auth: VECTOR.auth };
    const first = await encryptPayload("same message", keys);
    const second = await encryptPayload("same message", keys);

    expect(bytesToB64url(first)).not.toBe(bytesToB64url(second));
    // …because both the salt and the ephemeral key are fresh.
    expect([...first.slice(0, 16)]).not.toEqual([...second.slice(0, 16)]);
    expect([...first.slice(21, 86)]).not.toEqual([...second.slice(21, 86)]);
  });

  it("carries a GCM tag, so tampering is detectable", async () => {
    const body = await encryptPayload("hi", {
      p256dh: VECTOR.p256dh,
      auth: VECTOR.auth,
    });
    // header(86) + plaintext(2) + delimiter(1) + 16-byte tag
    expect(body.length).toBe(86 + 2 + 1 + 16);
  });
});
