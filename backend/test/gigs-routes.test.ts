/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const G1 = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("/api/gigs", () => {
  it("creates a gig with defaults (status lead, source manual)", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, {
      location: "Costco tasting stand",
      dateTime: Date.UTC(2026, 8, 12, 10),
      amountOfferedCents: 15000,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("lead");
    expect(body["source"]).toBe("manual");
    expect(body["clientId"]).toBeNull();
  });

  it("accepts a status transition via PUT", async () => {
    await api(U1, "PUT", `/api/gigs/${G1}`, { status: "lead" });
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, {
      status: "confirmed",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("confirmed");
  });

  it("links a gig to an owned client", async () => {
    await api(U1, "PUT", `/api/clients/${CLIENT}`, { name: "Acme" });
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, { clientId: CLIENT });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { clientId: string }).clientId).toBe(CLIENT);
  });

  it("400s when linking a client that is not the caller's", async () => {
    await api(U2, "PUT", `/api/clients/${CLIENT}`, { name: "Theirs" });
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, { clientId: CLIENT });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid status", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, { status: "maybe" });
    expect(res.status).toBe(400);
  });

  it("400s on non-integer cents", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${G1}`, {
      amountOfferedCents: 12.5,
    });
    expect(res.status).toBe(400);
  });

  it("400s on zero or negative money (null means not set)", async () => {
    expect(
      (await api(U1, "PUT", `/api/gigs/${G1}`, { amountOfferedCents: 0 })).status,
    ).toBe(400);
    expect(
      (await api(U1, "PUT", `/api/gigs/${G1}`, { amountPaidCents: -100 })).status,
    ).toBe(400);
  });

  it("lists only own gigs", async () => {
    await api(U1, "PUT", `/api/gigs/${G1}`, {});
    const res = await api(U2, "GET", "/api/gigs");
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});

// Phase 9: an optional length, which the calendar then honours instead
// of assuming four hours.
describe("gig duration", () => {
  const DUR = "91111111-1111-4111-8111-111111111111";

  it("round-trips durationMinutes and defaults it to null", async () => {
    await api(U1, "PUT", `/api/gigs/${DUR}`, { status: "lead" });
    const bare = (await (await api(U1, "GET", `/api/gigs/${DUR}`)).json()) as {
      durationMinutes: number | null;
    };
    expect(bare.durationMinutes).toBeNull();

    await api(U1, "PUT", `/api/gigs/${DUR}`, { status: "lead", durationMinutes: 210 });
    const withDuration = (await (await api(U1, "GET", `/api/gigs/${DUR}`)).json()) as {
      durationMinutes: number | null;
    };
    expect(withDuration.durationMinutes).toBe(210);
  });

  it("rejects a non-positive or absurd duration", async () => {
    for (const durationMinutes of [0, -30, 25 * 60]) {
      const res = await api(U1, "PUT", `/api/gigs/${DUR}`, {
        status: "lead",
        durationMinutes,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("gig title", () => {
  it("stores and returns an optional title", async () => {
    const id = "77777777-aaaa-4aaa-8aaa-777777777777";
    const put = await api(U1, "PUT", `/api/gigs/${id}`, {
      status: "lead",
      title: "Costco tasting",
    });
    expect(put.status).toBe(201);

    const got = await (await api(U1, "GET", `/api/gigs/${id}`)).json();
    expect((got as { title: string }).title).toBe("Costco tasting");
  });

  it("treats an absent title as null rather than rejecting it", async () => {
    const id = "77777777-bbbb-4bbb-8bbb-777777777777";
    const put = await api(U1, "PUT", `/api/gigs/${id}`, { status: "lead" });

    expect(put.status).toBe(201);
    expect(((await put.json()) as { title: string | null }).title).toBeNull();
  });

  it("refuses a title long enough to be a note", async () => {
    const id = "77777777-cccc-4ccc-8ccc-777777777777";
    const res = await api(U1, "PUT", `/api/gigs/${id}`, {
      status: "lead",
      title: "x".repeat(201),
    });

    expect(res.status).toBe(400);
  });
});
