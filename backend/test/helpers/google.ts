/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Offline Google ID-token fixtures: a real RSA keypair generated in
 * the test runtime, exported as a JWKS, and used to sign tokens with
 * the exact algorithm Google uses (RS256). The production code path
 * is exercised end-to-end without any network.
 */

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface FakeGoogle {
  jwks: { keys: (JsonWebKey & { kid: string })[] };
  makeIdToken(payload: Record<string, unknown>, kid?: string): Promise<string>;
}

export const TEST_KID = "test-key-1";

export async function makeFakeGoogle(): Promise<FakeGoogle> {
  // workers-types widens generateKey's return to CryptoKey |
  // CryptoKeyPair; RSA params always produce a pair.
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey & { kid: string };
  publicJwk.kid = TEST_KID;

  return {
    jwks: { keys: [publicJwk] },
    async makeIdToken(payload, kid = TEST_KID) {
      const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT", kid })}.${encodeJson(payload)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
    },
  };
}

/** A standard, valid Google ID-token payload for `clientId`. */
export function googlePayload(
  clientId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: clientId,
    sub: "google-sub-123",
    email: "gig.worker@example.com",
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}
