/**
 * Opaque bearer tokens and their stored form.
 *
 * Two callers, one rule: the raw token goes out exactly once and only
 * its SHA-256 hash is persisted, so a leaked database yields nothing
 * replayable. Refresh tokens (docs/plan.md §6) and availability links
 * (Phase 12) had the same eight lines copied into each store; a rule
 * this load-bearing should be stated once.
 *
 * The hash is unsalted and uniterated on purpose. These are 128+ bits
 * of CSPRNG output, not passwords — there is no dictionary to attack,
 * and a slow KDF on the read path would only tax the request.
 */

/** A cryptographically random token, base64url, no padding. */
export function mintToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The only form of a token that is ever written down. */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
