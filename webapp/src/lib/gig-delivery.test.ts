import { describe, expect, it } from "vitest";
import { isDeliverable, isFinal, offeredStatuses } from "./gig-delivery.ts";
import { GIG_STATUSES } from "./types.ts";

const SHOOTS = { id: "c-photo", needsDelivery: true };
const TASTINGS = { id: "c-tasting", needsDelivery: false };
const CLIENTS = [SHOOTS, TASTINGS];

const ON = { clientsExpectDelivery: true };
const OFF = { clientsExpectDelivery: false };

describe("isDeliverable", () => {
  it("answers with the client's own switch", () => {
    expect(isDeliverable({ clientId: SHOOTS.id }, CLIENTS, ON)).toBe(true);
    expect(isDeliverable({ clientId: TASTINGS.id }, CLIENTS, OFF)).toBe(false);
  });

  it("the client's switch wins over the setting in both directions", () => {
    // The setting is a DEFAULT for new clients, not an override of
    // existing ones (settings-schema.ts). A client that says no is a
    // no even when the setting says yes, and vice versa.
    expect(isDeliverable({ clientId: SHOOTS.id }, CLIENTS, OFF)).toBe(true);
    expect(isDeliverable({ clientId: TASTINGS.id }, CLIENTS, ON)).toBe(false);
  });

  it("answers with the setting for a gig with no client", () => {
    expect(isDeliverable({ clientId: null }, CLIENTS, ON)).toBe(true);
    expect(isDeliverable({ clientId: null }, CLIENTS, OFF)).toBe(false);
  });

  it("answers with the setting when the client id matches nothing", () => {
    // The clients query may not have resolved yet; the setting is the
    // honest fallback until it does, not a flat "no".
    expect(isDeliverable({ clientId: "unknown" }, [], ON)).toBe(true);
    expect(isDeliverable({ clientId: "unknown" }, CLIENTS, OFF)).toBe(false);
  });

  it("answers false when settings have not loaded", () => {
    // The setting's own server default, so a cold start reads the same
    // as a user who never touched the switch.
    expect(isDeliverable({ clientId: null }, CLIENTS, undefined)).toBe(false);
    expect(isDeliverable({ clientId: "unknown" }, CLIENTS, undefined)).toBe(false);
  });

  it("still reads the client when settings have not loaded", () => {
    // The client's switch does not depend on the settings query.
    expect(isDeliverable({ clientId: SHOOTS.id }, CLIENTS, undefined)).toBe(true);
  });
});

describe("offeredStatuses", () => {
  it("lists every status for deliverable work", () => {
    expect(offeredStatuses("completed", true)).toEqual(GIG_STATUSES);
  });

  it("stops at completed for work that is not delivered", () => {
    expect(offeredStatuses("completed", false)).toEqual([
      "lead",
      "confirmed",
      "completed",
      "cancelled",
    ]);
  });

  it("keeps delivered listed on a gig already marked delivered", () => {
    // A stored value is never hidden: a <select> whose value is not
    // among its options shows the first one and lies about the record.
    expect(offeredStatuses("delivered", false)).toEqual(GIG_STATUSES);
  });

  it("returns a fresh array rather than the shared constant", () => {
    // A caller that sorts or splices what it gets back must not be
    // able to corrupt GIG_STATUSES for everyone else.
    expect(offeredStatuses("lead", true)).not.toBe(GIG_STATUSES);
  });
});

describe("isFinal", () => {
  it("completed is final when there is nothing to hand over", () => {
    expect(isFinal("completed", false)).toBe(true);
  });

  it("completed is not final on deliverable work — delivery is still to come", () => {
    expect(isFinal("completed", true)).toBe(false);
  });

  it("no other status is final, whatever the delivery answer", () => {
    // `delivered` included: it has its own hue and is not what this
    // rule decides; `cancelled` is an ending but not a finish.
    for (const status of GIG_STATUSES.filter((s) => s !== "completed")) {
      expect(isFinal(status, false), status).toBe(false);
      expect(isFinal(status, true), status).toBe(false);
    }
  });
});
