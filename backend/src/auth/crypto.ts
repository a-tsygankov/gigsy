/**
 * Encryption-at-rest for stored Google refresh tokens (docs/plan.md
 * §6): AES-256-GCM keyed by the REFRESH_TOKEN_ENC_KEY secret (32
 * random bytes, base64). Output format: base64(iv ‖ ciphertext‖tag)
 * with a fresh 12-byte IV per encryption. Decrypt failures of ANY
 * kind (wrong key, tampering, garbage) collapse to null — callers
 * treat that as "no usable token", never as a distinguishable error.
 */

const IV_BYTES = 12;

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(base64Key),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptString(
  plaintext: string,
  base64Key: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64(out);
}

export async function decryptString(
  blob: string,
  base64Key: string,
): Promise<string | null> {
  try {
    const bytes = fromBase64(blob);
    if (bytes.length <= IV_BYTES) return null;
    const key = await importKey(base64Key);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
