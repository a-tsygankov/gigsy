/**
 * Google sign-in verification (docs/plan.md §6).
 *
 * verifyGoogleIdToken: RS256 verification of the ID token against
 * Google's JWKS, then iss/aud/email claim checks. The JWKS fetch is
 * injected — production uses defaultJwksFetcher, tests a local
 * keypair. All failures collapse to null (uniform 401 upstream).
 *
 * exchangeAuthCode: one-time auth code → Google refresh token (needs
 * GOOGLE_CLIENT_SECRET). Only called when the client sends a code —
 * i.e. on consent grants that include Calendar scope.
 */
import { verify } from "hono/jwt";

export interface GoogleClaims {
  sub: string;
  email: string;
}

export interface GoogleJwks {
  keys: (JsonWebKey & { kid?: string })[];
}

export type JwksFetcher = () => Promise<GoogleJwks>;

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const defaultJwksFetcher: JwksFetcher = async () => {
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return (await res.json()) as GoogleJwks;
};

function decodeHeader(idToken: string): { kid?: string } | null {
  try {
    const headerB64 = idToken.split(".")[0] ?? "";
    const json = atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as { kid?: string };
  } catch {
    return null;
  }
}

export async function verifyGoogleIdToken(options: {
  idToken: string;
  clientId: string;
  fetchJwks: JwksFetcher;
}): Promise<GoogleClaims | null> {
  const header = decodeHeader(options.idToken);
  if (header?.kid === undefined) return null;

  let key: JsonWebKey | undefined;
  try {
    const jwks = await options.fetchJwks();
    key = jwks.keys.find((k) => k.kid === header.kid);
  } catch {
    return null;
  }
  if (key === undefined) return null;

  try {
    // hono/jwt accepts a JWK as the key and enforces exp/nbf/iat.
    const payload = await verify(options.idToken, key, "RS256");
    const iss = payload["iss"];
    const aud = payload["aud"];
    const sub = payload["sub"];
    const email = payload["email"];
    if (typeof iss !== "string" || !GOOGLE_ISSUERS.includes(iss)) return null;
    if (aud !== options.clientId) return null;
    if (typeof sub !== "string" || sub.length === 0) return null;
    if (typeof email !== "string" || email.length === 0) return null;
    return { sub, email };
  } catch {
    return null;
  }
}

export async function exchangeAuthCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<{ refreshToken: string } | null> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: options.code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: options.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { refresh_token?: string };
    return typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { refreshToken: body.refresh_token }
      : null;
  } catch {
    return null;
  }
}
