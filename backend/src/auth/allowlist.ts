/**
 * Who may sign in at all.
 *
 * Until this existed, the only thing keeping strangers out was the
 * Google OAuth consent screen sitting in Testing mode — a setting in a
 * console, not a property of the app. Publishing the OAuth app would
 * have opened Gigsy to every Google account on earth in the same
 * minute, with no code change and no warning.
 *
 * Deliberately opt-in: an unset or empty list allows everyone, which is
 * the behaviour that already shipped. Defaulting to "deny" would lock
 * the owner out of their own deployment the first time they forgot to
 * set it, and a security control that strands you is one you turn off.
 */

/** Split, trimmed, lowercased, empties dropped. Exported for the config
 *  endpoint, which reports whether a list is in force. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/**
 * Whether this address may sign in.
 *
 * Case-insensitive, because Google addresses are and a list typed by
 * hand will not be. No wildcards or domain matching: those invite
 * "@gmail.com" as an entry, which is indistinguishable from no list at
 * all while looking like a restriction.
 */
export function isAllowedEmail(email: string, raw: string | undefined): boolean {
  const allowed = parseAllowlist(raw);
  if (allowed.length === 0) return true;
  return allowed.includes(email.trim().toLowerCase());
}
