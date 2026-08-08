/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";

const U1 = "user-1";
const U2 = "user-2";
const PAY = "44444444-dddd-4ddd-8ddd-444444444444";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function upload(
  userId: string,
  paymentId: string,
  bytes: Uint8Array,
): Promise<Response> {
  const token = await issueAccessToken({
    userId,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return SELF.fetch(`https://localhost/api/payments/${paymentId}/confirmation`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: bytes,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 5000 });
});

describe("payment confirmation upload/download", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch(
      `https://localhost/api/payments/${PAY}/confirmation`,
      { method: "PUT", body: BYTES },
    );
    expect(res.status).toBe(401);
  });

  it("stores the object under a user-prefixed key and records it", async () => {
    const res = await upload(U1, PAY, BYTES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmationR2Key: string };
    expect(body.confirmationR2Key).toBe(`u/${U1}/payments/${PAY}/confirmation`);

    const record = (await (
      await api(U1, "GET", `/api/payments/${PAY}`)
    ).json()) as { confirmationR2Key: string };
    expect(record.confirmationR2Key).toBe(body.confirmationR2Key);
  });

  it("streams the object back with its content type", async () => {
    await upload(U1, PAY, BYTES);
    const res = await api(U1, "GET", `/api/payments/${PAY}/confirmation`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("404s for another user and for a payment without a confirmation", async () => {
    await upload(U1, PAY, BYTES);
    expect((await api(U2, "GET", `/api/payments/${PAY}/confirmation`)).status).toBe(
      404,
    );
    expect((await upload(U2, PAY, BYTES)).status).toBe(404);
  });
});
