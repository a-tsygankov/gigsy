import { describe, it, expect } from "vitest";
import { ApiClient, type TokenSource } from "../lib/api.ts";
import { makeConsoleDataSource } from "./HiddenConsole.tsx";

function tokens(): TokenSource {
  return {
    getAccessToken: async () => "t",
    refresh: async () => false,
  };
}

describe("makeConsoleDataSource — worker logs through the authed client", () => {
  it("returns entries when the API responds", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ entries: [{ ts: 1, level: "info", msg: "hello" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const source = makeConsoleDataSource(new ApiClient(tokens(), fetchFn));

    const logs = await source.getWorkerLogs(10);

    expect(logs).toHaveLength(1);
    expect(logs?.[0]?.msg).toBe("hello");
  });

  it("degrades to null (unreachable) on 401 — signed-out console", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      })) as typeof fetch;
    const source = makeConsoleDataSource(new ApiClient(tokens(), fetchFn));

    expect(await source.getWorkerLogs(10)).toBeNull();
  });

  it("degrades to null on network failure", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const source = makeConsoleDataSource(new ApiClient(tokens(), fetchFn));

    expect(await source.getWorkerLogs(10)).toBeNull();
  });
});
