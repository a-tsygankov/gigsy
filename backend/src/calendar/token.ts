/**
 * Resolving a user's stored Google refresh token — and self-healing
 * when it can no longer be read.
 *
 * A stored ciphertext stops decrypting when REFRESH_TOKEN_ENC_KEY is
 * rotated (setup-secrets.ps1 regenerates it), which is easy to do long
 * after connecting the calendar. The old behaviour was the worst of
 * both worlds: `connected` still reported true because a row existed,
 * so the UI offered "Sync now" and never "Connect", while every sync
 * quietly failed. The user had no way out.
 *
 * Clearing the unreadable value fixes that at the source: the next
 * status read reports disconnected and the dashboard offers Connect
 * again.
 */
import { decryptString } from "../auth/crypto.ts";
import type { UsersRepo, UserRecord } from "../repos/users.ts";
import { log } from "../logger.ts";

export async function resolveRefreshToken(
  usersRepo: UsersRepo,
  user: UserRecord,
  encKey: string,
  now = Date.now(),
): Promise<string | null> {
  if (user.googleRefreshTokenEnc == null) return null;

  const refreshToken = await decryptString(user.googleRefreshTokenEnc, encKey);
  if (refreshToken !== null) return refreshToken;

  await usersRepo.setGoogleRefreshTokenEnc(user.id, null, now);
  log.warn("calendar: stored token unreadable — disconnected so it can be re-granted", {
    userId: user.id,
  });
  return null;
}
