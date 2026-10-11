import { describe, it, expect } from "vitest";
import { cloudflareSender, senderFromEnv } from "../src/feedback/sender.ts";
import type { Bindings, SendEmailBinding } from "../src/env.ts";

/**
 * The one place that knows the `send_email` binding's shape
 * (docs/superpowers/specs/2026-10-11-feedback-design.md). The binding
 * itself does not exist in the test runtime, so the tests stand a plain
 * object in for it — which is what SendEmailBinding being a structural
 * type in env.ts is for.
 */

type Sent = Parameters<SendEmailBinding["send"]>[0];

function fakeBinding(): SendEmailBinding & { calls: Sent[] } {
  const calls: Sent[] = [];
  return {
    calls,
    send: async (message) => {
      calls.push(message);
      return { messageId: "cf-msg-1" };
    },
  };
}

describe("senderFromEnv", () => {
  it("is null without an EMAIL binding — the shape of every deployment until Email Sending is on", () => {
    expect(senderFromEnv({} as Bindings)).toBeNull();
    expect(senderFromEnv({ EMAIL: undefined } as unknown as Bindings)).toBeNull();
  });

  it("forwards to the binding's send when EMAIL is bound", async () => {
    const binding = fakeBinding();
    const sender = senderFromEnv({ EMAIL: binding } as unknown as Bindings);
    expect(sender).not.toBeNull();

    const result = await sender!.send({
      from: "feedback@example.com",
      to: ["admin-a@example.com"],
      subject: "[Gigsy feedback] hi",
      text: "body",
      attachments: [],
    });

    expect(result).toEqual({ messageId: "cf-msg-1" });
    expect(binding.calls).toHaveLength(1);
    expect(binding.calls[0]!.to).toEqual(["admin-a@example.com"]);
  });
});

describe("cloudflareSender", () => {
  it("maps the message onto the binding's builder, images as plain attachments", async () => {
    const binding = fakeBinding();
    const png = new Uint8Array([1, 2, 3]).buffer;

    await cloudflareSender(binding).send({
      from: "feedback@example.com",
      to: ["admin-a@example.com", "admin-b@example.com"],
      subject: "[Gigsy feedback] broken",
      text: "it broke",
      attachments: [{ filename: "shot.png", type: "image/png", content: png }],
    });

    expect(binding.calls).toEqual([
      {
        from: "feedback@example.com",
        to: ["admin-a@example.com", "admin-b@example.com"],
        subject: "[Gigsy feedback] broken",
        text: "it broke",
        attachments: [
          { disposition: "attachment", filename: "shot.png", type: "image/png", content: png },
        ],
      },
    ]);
  });

  it("lets the binding's rejection surface — the route turns it into `failed`", async () => {
    const binding: SendEmailBinding = {
      send: async () => {
        throw new Error("domain not onboarded");
      },
    };
    await expect(
      cloudflareSender(binding).send({
        from: "f@example.com",
        to: ["a@example.com"],
        subject: "s",
        text: "t",
        attachments: [],
      }),
    ).rejects.toThrow("domain not onboarded");
  });
});
