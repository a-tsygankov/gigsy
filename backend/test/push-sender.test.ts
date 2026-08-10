/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sendPush, type PushTarget } from "../src/push/sender.ts";
import { base64UrlEncode, type VapidKeys } from "../src/push/vapid.ts";

// A real subscription's public key material — taken from the RFC 8291
// example, which is a valid P-256 point and auth secret.
const TARGET: PushTarget = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

let vapid: VapidKeys;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  vapid = { publicKey: base64UrlEncode(raw), privateKey: jwk.d! };
});

function responder(status: number) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const options = (fetchFn: typeof fetch) => ({
  vapid,
  subject: "mailto:dev@example.com",
  fetchFn,
});

describe("sendPush", () => {
  it("posts the encrypted body to the endpoint with VAPID auth", async () => {
    const { seen, fetchFn } = responder(201);
    const result = await sendPush(TARGET, "Acme still owes you $190", options(fetchFn));

    expect(result).toBe("sent");
    const call = seen[0]!;
    expect(call.url).toBe(TARGET.endpoint);
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(headers["TTL"])).toBeGreaterThan(0);

    // The body is ciphertext, never the message itself — the push
    // service must not be able to read it.
    const body = new Uint8Array(call.init.body as ArrayBuffer);
    expect(body.length).toBeGreaterThan(86);
    expect(new TextDecoder().decode(body)).not.toContain("Acme");
  });

  it("treats any 2xx as delivered", async () => {
    for (const status of [200, 201, 202]) {
      const { fetchFn } = responder(status);
      expect(await sendPush(TARGET, "hi", options(fetchFn))).toBe("sent");
    }
  });

  // The distinction that matters: a dead subscription must be pruned,
  // a transient failure must not be.
  it("reports a dead subscription as gone (404/410)", async () => {
    for (const status of [404, 410]) {
      const { fetchFn } = responder(status);
      expect(await sendPush(TARGET, "hi", options(fetchFn))).toBe("gone");
    }
  });

  it("reports other rejections as merely failed", async () => {
    for (const status of [429, 500, 503]) {
      const { fetchFn } = responder(status);
      expect(await sendPush(TARGET, "hi", options(fetchFn))).toBe("failed");
    }
  });

  it("reports a network error as failed rather than throwing", async () => {
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await sendPush(TARGET, "hi", options(fetchFn))).toBe("failed");
  });

  it("does not treat unusable subscription keys as a dead endpoint", async () => {
    const { fetchFn } = responder(201);
    const broken = { ...TARGET, p256dh: "not-a-key" };

    // Encryption throws; the result is "failed", never "sent", and
    // never "gone" — we cannot tell from here that it is permanent.
    expect(await sendPush(broken, "hi", options(fetchFn))).toBe("failed");
  });

  it("sends a fresh ciphertext per call", async () => {
    const { seen, fetchFn } = responder(201);
    await sendPush(TARGET, "same", options(fetchFn));
    await sendPush(TARGET, "same", options(fetchFn));

    const first = new Uint8Array(seen[0]!.init.body as ArrayBuffer);
    const second = new Uint8Array(seen[1]!.init.body as ArrayBuffer);
    expect([...first]).not.toEqual([...second]);
  });
});
