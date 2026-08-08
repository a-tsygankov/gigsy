/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("/api/clients", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/clients");
    expect(res.status).toBe(401);
  });

  it("creates via PUT with a client-generated UUID", async () => {
    const res = await api(U1, "PUT", `/api/clients/${C1}`, {
      name: "Acme Staffing",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(C1);
    expect(body["name"]).toBe("Acme Staffing");
    expect(body["createdAt"]).toBeGreaterThan(0);
    expect(body["modifiedAt"]).toBe(body["createdAt"]);
  });

  it("updates via PUT on the same id, bumping modifiedAt only", async () => {
    await api(U1, "PUT", `/api/clients/${C1}`, { name: "Before" });
    const created = (await (
      await api(U1, "GET", `/api/clients/${C1}`)
    ).json()) as { createdAt: number; modifiedAt: number };

    const res = await api(U1, "PUT", `/api/clients/${C1}`, { name: "After" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      createdAt: number;
      modifiedAt: number;
    };
    expect(body.name).toBe("After");
    expect(body.createdAt).toBe(created.createdAt);
    expect(body.modifiedAt).toBeGreaterThanOrEqual(created.modifiedAt);
  });

  it("lists only the caller's clients", async () => {
    await api(U1, "PUT", `/api/clients/${C1}`, { name: "Mine" });
    await api(U2, "PUT", `/api/clients/${C2}`, { name: "Theirs" });

    const res = await api(U1, "GET", "/api/clients");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((c) => c.id)).toEqual([C1]);
  });

  it("404s (not 403) when PUTting an id owned by another user", async () => {
    await api(U1, "PUT", `/api/clients/${C1}`, { name: "Mine" });
    const res = await api(U2, "PUT", `/api/clients/${C1}`, { name: "Steal" });
    expect(res.status).toBe(404);

    const mine = (await (
      await api(U1, "GET", `/api/clients/${C1}`)
    ).json()) as { name: string };
    expect(mine.name).toBe("Mine");
  });

  it("404s on GET of another user's client", async () => {
    await api(U1, "PUT", `/api/clients/${C1}`, { name: "Mine" });
    const res = await api(U2, "GET", `/api/clients/${C1}`);
    expect(res.status).toBe(404);
  });

  it("400s on an invalid payload", async () => {
    const res = await api(U1, "PUT", `/api/clients/${C1}`, { name: "" });
    expect(res.status).toBe(400);
  });

  it("400s on a non-UUID id", async () => {
    const res = await api(U1, "PUT", "/api/clients/not-a-uuid", {
      name: "X",
    });
    expect(res.status).toBe(400);
  });

  it("deletes own client; delete is scoped", async () => {
    await api(U1, "PUT", `/api/clients/${C1}`, { name: "Mine" });

    const forbidden = await api(U2, "DELETE", `/api/clients/${C1}`);
    expect(forbidden.status).toBe(404);

    const ok = await api(U1, "DELETE", `/api/clients/${C1}`);
    expect(ok.status).toBe(204);

    const gone = await api(U1, "GET", `/api/clients/${C1}`);
    expect(gone.status).toBe(404);
  });
});
