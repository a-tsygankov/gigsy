/**
 * Web Push payload encryption — RFC 8291 (`aes128gcm`, itself built on
 * RFC 8188). The push service only ever relays ciphertext; nobody but
 * the subscribed browser can read the message.
 *
 * Doing this properly is what lets the service worker stay
 * credential-free: it receives the text directly instead of having to
 * authenticate and fetch it, which would mean a second context racing
 * the page for a single-use refresh token.
 *
 * The shape, once:
 *   ECDH(ours, theirs) ─┬─► IKM  = HKDF(salt=auth,  info="WebPush: info"…)
 *                       └─► PRK  = HKDF(salt=random, ikm=IKM)
 *                              ├─► CEK   (16B, "Content-Encoding: aes128gcm")
 *                              └─► NONCE (12B, "Content-Encoding: nonce")
 *   body = salt ‖ recordSize ‖ len(pubkey) ‖ pubkey ‖ AES-GCM(plaintext ‖ 0x02)
 */

const encoder = new TextEncoder();

/** Single record; the browser reassembles nothing larger than this. */
const RECORD_SIZE = 4096;

export interface SubscriptionKeys {
  /** base64url 65-byte uncompressed P-256 point (`p256dh`). */
  p256dh: string;
  /** base64url 16-byte shared secret (`auth`). */
  auth: string;
}

export interface EncryptOptions {
  /** Injectable so the RFC 8291 §5 vector can be reproduced exactly;
   * production always takes the random default. */
  salt?: Uint8Array;
  ephemeral?: { publicKey: Uint8Array; privateKeyD: string };
}

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

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** WebCrypto's HKDF is extract-and-expand in one call, which is
 * exactly what each of the three derivations below needs. */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(derived);
}

/** A raw P-256 scalar can't be imported directly, so it is rebuilt as
 * a JWK using the X/Y from the matching public point. */
async function importEcdhPrivate(
  publicKey: Uint8Array,
  d: string,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(publicKey.slice(1, 33)),
      y: bytesToB64url(publicKey.slice(33, 65)),
      d,
      ext: true,
      key_ops: ["deriveBits"],
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export async function encryptPayload(
  plaintext: string,
  keys: SubscriptionKeys,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(keys.p256dh);
  const authSecret = b64urlToBytes(keys.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // Our ephemeral key: fresh per message, which is what makes the salt
  // and derived keys unique even for identical plaintext.
  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (options.ephemeral !== undefined) {
    asPublic = options.ephemeral.publicKey;
    asPrivate = await importEcdhPrivate(asPublic, options.ephemeral.privateKeyD);
  } else {
    // generateKey is typed as CryptoKey | CryptoKeyPair; an asymmetric
    // algorithm always yields the pair.
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as unknown as CryptoKeyPair;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    asPrivate = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // @cloudflare/workers-types declares the peer key as `$public`, but
  // the runtime (and the WebCrypto spec) want `public` — the RFC 8291
  // vector test is what proves which one actually travels.
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as Parameters<
    typeof crypto.subtle.deriveBits
  >[0];
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, asPrivate, 256),
  );

  // RFC 8291 §3.4 — the auth secret is the salt here, and the info
  // binds the derivation to both parties' public keys.
  const ikm = await hkdf(
    sharedSecret,
    authSecret,
    concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );

  const cek = await hkdf(
    ikm,
    salt,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 is the RFC 8188 delimiter marking this as the final record.
  const record = concat(encoder.encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext,
  );
}
