/**
 * The per-user capture address, in one place.
 *
 * `u-<userId>@<domain>`. One side builds it for the Settings screen,
 * the other parses it off an inbound message, and a disagreement
 * between them is mail that bounces with no clue why — so neither gets
 * to have its own opinion about the format.
 *
 * The address is unguessable, not secret. A UUID resists guessing and
 * does nothing against someone reading it over your shoulder, so what
 * bounds the damage is the per-user daily cap on the handler, not the
 * address itself.
 */

/**
 * The address to show a user, or null when capture is not configured.
 *
 * Null rather than a half-built address: showing `u-abc@undefined`
 * would get typed into a mail client and bounce, which is a worse
 * outcome than saying the feature is off.
 */
export function captureAddressFor(
  userId: string,
  domain: string | undefined,
): string | null {
  const host = (domain ?? "").trim();
  if (host === "") return null;
  return `u-${userId}@${host}`;
}

/**
 * The user id an inbound message was addressed to, or null.
 *
 * Lowercased because mail servers do not preserve case in the local
 * part, and the ids this is compared against are lowercase UUIDs.
 * The domain is deliberately ignored: Email Routing decides that with
 * a catch-all before the Worker ever sees the message, and re-checking
 * it here would only add a second place to keep in step.
 */
export function userIdFromAddress(to: string): string | null {
  const local = (to.split("@")[0] ?? "").toLowerCase();
  if (!local.startsWith("u-")) return null;
  const id = local.slice(2);
  return id === "" ? null : id;
}
