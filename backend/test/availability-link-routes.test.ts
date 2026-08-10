/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Managing your own availability link (Phase 12, Task 5).
 *
 * The counterpart to /api/a/:token: that one is read by strangers and
 * has no login, this one is how the owner mints, inspects and kills
 * the link — and it is behind auth like everything else.
 *
 * The shape here is forced by a decision made two tasks ago. Only the
 * SHA-256 hash of a token is stored, so the raw value exists exactly
 * once, in the response to POST. There is no endpoint that can show it
 * again, because there is nothing to show it from. That is the cost of
 * hashing and it is the right cost — but it means "regenerate" has to
 * replace the reader's job of "remind me".
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { AvailabilityTokenStore } from "../src/repos/availability-tokens.ts";

const U1 = "link-user-1";
const U2 = "link-user-2";

interface LinkState {
  active: { createdAt: number; expiresAt: number | null } | null;
}
interface MintedLink {
  token: string;
  path: string;
  createdAt: number;
  expiresAt: number | null;
}

const getLink = async (user = U1): Promise<LinkState> =>
  (await (await api(user, "GET", "/api/availability/link")).json()) as LinkState;

async function mint(
  body: Record<string, unknown> = {},
  user = U1,
): Promise<Response> {
  return api(user, "POST", "/api/availability/link", body);
}

const minted = async (
  body: Record<string, unknown> = {},
  user = U1,
): Promise<MintedLink> => (await (await mint(body, user)).json()) as MintedLink;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2, "link-two@example.com");
});

describe("GET /api/availability/link", () => {
  it("reports no link before one is made", async () => {
    expect(await getLink()).toEqual({ active: null });
  });

  it("describes a live link without reproducing it", async () => {
    // Nothing stored can rebuild the token, and this is the test that
    // says so out loud — if it ever fails, hashing has been undone.
    const made = await minted();

    const state = await getLink();

    expect(state.active).not.toBeNull();
    expect(JSON.stringify(state)).not.toContain(made.token);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await SELF.fetch("https://localhost/api/availability/link");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/availability/link", () => {
  it("returns the token once, with the path to share", async () => {
    const made = await minted();

    expect(made.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.path).toBe(`/a/${made.token}`);
  });

  it("mints a link that the public endpoint then honours", async () => {
    // The round trip that matters: what this hands back must actually
    // open the page, with no auth on the second request.
    const made = await minted();

    const res = await SELF.fetch(`https://localhost/api/a/${made.token}`);

    expect(res.status).toBe(200);
  });

  it("does not expire by default", async () => {
    expect((await minted()).expiresAt).toBeNull();
  });

  it("accepts an expiry in days", async () => {
    // "A link sent to an agency in March should not still work in
    // December unless you said so" — optional, because saying so is
    // the user's call.
    const made = await minted({ expiresInDays: 30 });

    expect(made.expiresAt).not.toBeNull();
    const days = (made.expiresAt! - made.createdAt) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
  });

  it("rejects an expiry that is not a sensible number of days", async () => {
    expect((await mint({ expiresInDays: 0 })).status).toBe(400);
    expect((await mint({ expiresInDays: -5 })).status).toBe(400);
    expect((await mint({ expiresInDays: 4000 })).status).toBe(400);
  });

  it("rejects a key it does not know rather than ignoring it", async () => {
    expect((await mint({ expiresInDay: 30 })).status).toBe(400);
  });

  it("kills the previous link when it mints a new one", async () => {
    // Regenerate IS the revoke — that is the whole model.
    const old = await minted();
    const fresh = await minted();

    expect((await SELF.fetch(`https://localhost/api/a/${old.token}`)).status).toBe(404);
    expect((await SELF.fetch(`https://localhost/api/a/${fresh.token}`)).status).toBe(200);
  });

  it("never mints the same token twice", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add((await minted()).token);

    expect(seen.size).toBe(5);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await SELF.fetch("https://localhost/api/availability/link", {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/availability/link", () => {
  it("stops the link working immediately", async () => {
    const made = await minted();

    const res = await api(U1, "DELETE", "/api/availability/link");

    expect(res.status).toBe(200);
    expect((await SELF.fetch(`https://localhost/api/a/${made.token}`)).status).toBe(404);
  });

  it("reports no active link afterwards", async () => {
    await minted();
    await api(U1, "DELETE", "/api/availability/link");

    expect(await getLink()).toEqual({ active: null });
  });

  it("is not an error when there is nothing to revoke", async () => {
    // Two taps on "revoke" must not produce a scary message.
    expect((await api(U1, "DELETE", "/api/availability/link")).status).toBe(200);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await SELF.fetch("https://localhost/api/availability/link", {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });
});

describe("one user's link is not another's", () => {
  it("does not show U2 anything about U1's link", async () => {
    await minted({}, U1);

    expect(await getLink(U2)).toEqual({ active: null });
  });

  it("does not let U2's revoke touch U1's link", async () => {
    const mine = await minted({}, U1);

    await api(U2, "DELETE", "/api/availability/link");

    expect((await SELF.fetch(`https://localhost/api/a/${mine.token}`)).status).toBe(200);
  });

  it("resolves each user's link to that user", async () => {
    const oneToken = (await minted({}, U1)).token;
    const twoToken = (await minted({}, U2)).token;

    const store = AvailabilityTokenStore.for(env.DB);
    expect(await store.resolve(oneToken, Date.now())).toBe(U1);
    expect(await store.resolve(twoToken, Date.now())).toBe(U2);
  });
});
