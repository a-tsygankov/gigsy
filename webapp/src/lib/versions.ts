/**
 * Tier versions for the hidden console. The client version is inlined
 * at build time from package.json (auto-bumped by the pre-commit
 * hook); worker + schema versions come from GET /api/version and
 * degrade to null offline — the console must render without a network.
 */
import pkg from "../../package.json";

export const CLIENT_VERSION: string = pkg.version;

export interface TierVersions {
  client: string;
  worker: string | null;
  schema: string | null;
  env: string | null;
}

interface VersionResponse {
  worker?: { version?: string; env?: string };
  schema?: { version?: string | null };
}

const OFFLINE: Omit<TierVersions, "client"> = { worker: null, schema: null, env: null };

export async function fetchTierVersions(
  fetchFn: typeof fetch = fetch,
): Promise<TierVersions> {
  try {
    const res = await fetchFn("/api/version");
    if (!res.ok) return { client: CLIENT_VERSION, ...OFFLINE };
    const body = (await res.json()) as VersionResponse;
    return {
      client: CLIENT_VERSION,
      worker: body.worker?.version ?? null,
      schema: body.schema?.version ?? null,
      env: body.worker?.env ?? null,
    };
  } catch {
    return { client: CLIENT_VERSION, ...OFFLINE };
  }
}
