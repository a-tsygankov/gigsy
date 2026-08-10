/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import {
  audienceFor,
  base64UrlDecode,
  base64UrlEncode,
  vapidAuthorization,
  type VapidKeys,
} from "../src/push/vapid.ts";

/** A real P-256 pair, generated here rather than hardcoded, so the
 * test proves the signature verifies rather than that it matches a
 * blob someone once pasted in. */
let keys: VapidKeys;
let publicCryptoKey: CryptoKey;

beforeAll(async () => {
  // Typed as CryptoKey | CryptoKeyPair; ECDSA always yields the pair.
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  keys = { publicKey: base64UrlEncode(raw), privateKey: jwk.d! };
  publicCryptoKey = pair.publicKey;
});

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123?token=xyz";

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as Record<
    string,
    unknown
  >;
}

describe("base64url", () => {
  it("round-trips bytes without padding or url-unsafe characters", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 62, 63]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
  });
});

describe("audienceFor", () => {
  // Several push services reject a full-URL audience outright.
  it("is the endpoint's origin, never the full URL", () => {
    expect(audienceFor(ENDPOINT)).toBe("https://fcm.googleapis.com");
    expect(audienceFor("https://updates.push.services.mozilla.com/wpush/v2/gAA")).toBe(
      "https://updates.push.services.mozilla.com",
    );
  });
});

describe("vapidAuthorization", () => {
  it("produces a vapid header carrying the JWT and the public key", async () => {
    const header = await vapidAuthorization({
      endpoint: ENDPOINT,
      keys,
      subject: "mailto:dev@example.com",
    });

    expect(header.startsWith("vapid t=")).toBe(true);
    expect(header).toContain(`, k=${keys.publicKey}`);
  });

  it("signs claims a push service will accept", async () => {
    const now = 1_760_000_000_000;
    const header = await vapidAuthorization({
      endpoint: ENDPOINT,
      keys,
      subject: "mailto:dev@example.com",
      now,
    });
    const jwt = header.slice("vapid t=".length).split(",")[0]!;
    const [rawHeader, rawClaims] = jwt.split(".");

    expect(decodeSegment(rawHeader!)).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = decodeSegment(rawClaims!);
    expect(claims["aud"]).toBe("https://fcm.googleapis.com");
    expect(claims["sub"]).toBe("mailto:dev@example.com");
    // Comfortably inside the 24h services allow, and in the future.
    const exp = claims["exp"] as number;
    expect(exp).toBeGreaterThan(now / 1000);
    expect(exp - now / 1000).toBeLessThanOrEqual(24 * 60 * 60);
  });

  // The point of the exercise: the signature must actually verify
  // against the public key we hand out.
  it("emits a signature that verifies against the public key", async () => {
    const header = await vapidAuthorization({
      endpoint: ENDPOINT,
      keys,
      subject: "mailto:dev@example.com",
    });
    const jwt = header.slice("vapid t=".length).split(",")[0]!;
    const [h, c, sig] = jwt.split(".");

    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicCryptoKey,
      base64UrlDecode(sig!),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(verified).toBe(true);
  });

  it("rejects a public key that isn't an uncompressed P-256 point", async () => {
    await expect(
      vapidAuthorization({
        endpoint: ENDPOINT,
        keys: { publicKey: base64UrlEncode(new Uint8Array(10)), privateKey: keys.privateKey },
        subject: "mailto:dev@example.com",
      }),
    ).rejects.toThrow(/uncompressed P-256/);
  });
});

/**
 * The keys the worker uses are minted by scripts/setup-secrets.ps1
 * (`GENERATE_VAPID`), not by WebCrypto — different runtime, different
 * export path, same required format. This pair came from that script,
 * so if its encoding ever drifts from what the worker can import, this
 * fails here rather than silently in production.
 */
describe("keys minted by setup-secrets.ps1", () => {
  const fromScript: VapidKeys = {
    publicKey:
      "BF-bLRDu_TUmGC9_AhKD_ZFI6lS_ZGRnuIAleFVsYcLjIP7Ontvnwmf2YDue91llbX7hSErb0klnBwZp7NgclBo",
    privateKey: "3eT1lnQWN8fRwkwGPQIuG51_zSLnLo0iWtwNwSsrCh8",
  };

  it("has the shape Web Push requires", () => {
    const publicBytes = base64UrlDecode(fromScript.publicKey);
    expect(publicBytes.length).toBe(65);
    expect(publicBytes[0]).toBe(0x04); // uncompressed point
    expect(base64UrlDecode(fromScript.privateKey).length).toBe(32);
  });

  it("signs a header the worker can actually produce", async () => {
    const header = await vapidAuthorization({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: fromScript,
      subject: "mailto:dev@example.com",
    });

    const jwt = header.slice("vapid t=".length).split(",")[0]!;
    const [h, c, sig] = jwt.split(".");

    // Verify against the public half the script printed for
    // wrangler.toml — proving the two halves really are a pair.
    const publicBytes = base64UrlDecode(fromScript.publicKey);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlDecode(sig!),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
