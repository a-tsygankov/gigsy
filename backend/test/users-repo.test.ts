/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./helpers/db.ts";
import { UsersRepo } from "../src/repos/users.ts";

beforeAll(async () => {
  await applyMigrations(env.DB);
});

describe("UsersRepo.upsertByEmail", () => {
  it("creates a user with a generated UUID id", async () => {
    const repo = UsersRepo.for(env.DB);
    const user = await repo.upsertByEmail("a@example.com", 1000);
    expect(user.email).toBe("a@example.com");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.createdAt).toBe(1000);
  });

  it("returns the same user on repeat logins", async () => {
    const repo = UsersRepo.for(env.DB);
    const first = await repo.upsertByEmail("a@example.com", 1000);
    const second = await repo.upsertByEmail("a@example.com", 2000);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(1000);
  });

  it("stores the encrypted Google refresh token and bumps modified_at", async () => {
    const repo = UsersRepo.for(env.DB);
    const user = await repo.upsertByEmail("a@example.com", 1000);

    await repo.setGoogleRefreshTokenEnc(user.id, "enc-blob", 5000);

    const reread = await repo.get(user.id);
    expect(reread?.googleRefreshTokenEnc).toBe("enc-blob");
    expect(reread?.modifiedAt).toBe(5000);
  });
});
