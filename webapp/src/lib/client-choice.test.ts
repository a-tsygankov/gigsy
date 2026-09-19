import { describe, expect, it, vi } from "vitest";
import {
  NEW_CLIENT_NAME_REQUIRED,
  clientChoiceFromId,
  clientChoiceId,
  hasClientName,
  resolveClientChoice,
} from "./client-choice.ts";
import type { Client, ClientInput } from "./types.ts";

/** A `putClient` that echoes what it was given as a stored record. */
function makeData() {
  const putClient = vi.fn(
    async (id: string, input: ClientInput): Promise<Client> => ({
      id,
      name: input.name,
      contactInfo: input.contactInfo ?? null,
      notes: input.notes ?? null,
      createdAt: 0,
      modifiedAt: 0,
    }),
  );
  return { putClient };
}

describe("resolveClientChoice", () => {
  it("resolves none to null without writing anything", async () => {
    const data = makeData();
    await expect(resolveClientChoice(data, { kind: "none" })).resolves.toBeNull();
    expect(data.putClient).not.toHaveBeenCalled();
  });

  it("resolves existing to its id without writing anything", async () => {
    const data = makeData();
    await expect(resolveClientChoice(data, { kind: "existing", id: "c1" })).resolves.toBe("c1");
    expect(data.putClient).not.toHaveBeenCalled();
  });

  it("creates a new client exactly once, with the trimmed name, and returns its id", async () => {
    const data = makeData();
    const id = await resolveClientChoice(
      data,
      { kind: "new", name: "  Acme Staffing  " },
      () => "fresh",
    );
    expect(id).toBe("fresh");
    expect(data.putClient).toHaveBeenCalledTimes(1);
    expect(data.putClient).toHaveBeenCalledWith("fresh", { name: "Acme Staffing" });
  });

  it("refuses a blank new name and writes nothing", async () => {
    // The guarantee behind the screens' own check: nothing slips past
    // into a client called "".
    const data = makeData();
    await expect(resolveClientChoice(data, { kind: "new", name: "   " })).rejects.toThrow(
      NEW_CLIENT_NAME_REQUIRED,
    );
    expect(data.putClient).not.toHaveBeenCalled();
  });

  it("mints a UUID when no id factory is given", async () => {
    const data = makeData();
    const id = await resolveClientChoice(data, { kind: "new", name: "Bravo" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("clientChoiceId", () => {
  it("reads an id off existing only", () => {
    expect(clientChoiceId({ kind: "existing", id: "c1" })).toBe("c1");
    expect(clientChoiceId({ kind: "none" })).toBeNull();
    // A brand-new client has no other gigs: null, not "pending".
    expect(clientChoiceId({ kind: "new", name: "Acme" })).toBeNull();
  });
});

describe("clientChoiceFromId", () => {
  it("seeds a form from a stored gig's clientId", () => {
    expect(clientChoiceFromId("c1")).toEqual({ kind: "existing", id: "c1" });
    expect(clientChoiceFromId(null)).toEqual({ kind: "none" });
    expect(clientChoiceFromId(undefined)).toEqual({ kind: "none" });
  });
});

describe("hasClientName", () => {
  it("is false only for a new client with a blank name", () => {
    expect(hasClientName({ kind: "none" })).toBe(true);
    expect(hasClientName({ kind: "existing", id: "c1" })).toBe(true);
    expect(hasClientName({ kind: "new", name: "Acme" })).toBe(true);
    expect(hasClientName({ kind: "new", name: " " })).toBe(false);
  });
});
