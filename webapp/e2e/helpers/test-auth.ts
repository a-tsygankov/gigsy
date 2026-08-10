import { test, type APIRequestContext } from "@playwright/test";

/**
 * Signed-in specs run through the test-auth bypass
 * (POST /api/auth/test-login), which the worker only serves outside
 * production. Where it's absent they skip themselves.
 *
 * That skip is a trap when a job is *supposed* to cover authenticated
 * paths: the PR-preview deployment proxies to the production worker,
 * so the whole signed-in half of the suite skipped and the check still
 * reported green — 12 of 20 tests silently doing nothing. Any job that
 * claims to cover these paths sets E2E_REQUIRE_AUTH, which turns the
 * skip into a failure.
 */
export async function testAuthAvailable(
  request: APIRequestContext,
  baseURL: string,
): Promise<boolean> {
  try {
    const res = await request.get(`${baseURL}/api/auth/config`);
    if (!res.ok()) return false;
    const body = (await res.json()) as { testAuthEnabled?: boolean };
    return body.testAuthEnabled === true;
  } catch {
    return false;
  }
}

/** Guard for a signed-in spec's beforeEach. */
export async function requireTestAuth(
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  if (await testAuthAvailable(request, baseURL)) return;

  if (process.env["E2E_REQUIRE_AUTH"] === "1") {
    throw new Error(
      `Test auth is disabled at ${baseURL}, but E2E_REQUIRE_AUTH=1 — this job ` +
        "exists to cover signed-in paths, so skipping them would be a false pass. " +
        "Point it at a worker running with ENVIRONMENT=development.",
    );
  }
  test.skip(true, "test auth disabled on this deployment");
}
