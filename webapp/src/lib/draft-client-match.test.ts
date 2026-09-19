import { describe, expect, it } from "vitest";
import { CONFIDENT_MATCH, matchBand, seedDraftClient } from "./draft-client-match.ts";

describe("matchBand", () => {
  it("is none without a matched client, whatever the confidence says", () => {
    expect(matchBand({ matchedClientId: null, matchConfidence: 1 })).toBe("none");
    expect(matchBand({})).toBe("none");
  });

  it("is confident at the line and above", () => {
    expect(matchBand({ matchedClientId: "c1", matchConfidence: 1 })).toBe("confident");
    expect(matchBand({ matchedClientId: "c1", matchConfidence: CONFIDENT_MATCH })).toBe(
      "confident",
    );
  });

  it("is unsure below the line — where the server puts containment and initials", () => {
    expect(matchBand({ matchedClientId: "c1", matchConfidence: 0.8 })).toBe("unsure");
    expect(matchBand({ matchedClientId: "c1", matchConfidence: 0.75 })).toBe("unsure");
    expect(matchBand({ matchedClientId: "c1", matchConfidence: 0.6 })).toBe("unsure");
  });

  it("treats a match with no confidence recorded as unsure, not confident", () => {
    expect(matchBand({ matchedClientId: "c1", matchConfidence: null })).toBe("unsure");
    expect(matchBand({ matchedClientId: "c1" })).toBe("unsure");
  });
});

describe("seedDraftClient", () => {
  it("preselects a confident match with no question", () => {
    expect(
      seedDraftClient({ matchedClientId: "c1", matchConfidence: 0.97, clientName: "Acme" }),
    ).toEqual({ client: { kind: "existing", id: "c1" }, questionOpen: false });
  });

  it("opens the question, with nothing preselected, for an unsure match", () => {
    expect(
      seedDraftClient({ matchedClientId: "c1", matchConfidence: 0.8, clientName: "Acme" }),
    ).toEqual({ client: { kind: "none" }, questionOpen: true });
  });

  it("offers a new client named as the document spelt it when nothing matched", () => {
    expect(
      seedDraftClient({ matchedClientId: null, matchConfidence: null, clientName: " ACME " }),
    ).toEqual({ client: { kind: "new", name: "ACME" }, questionOpen: false });
  });

  it("offers no client when nothing matched and no name was read", () => {
    expect(seedDraftClient({ matchedClientId: null, clientName: null })).toEqual({
      client: { kind: "none" },
      questionOpen: false,
    });
    expect(seedDraftClient({ clientName: "  " })).toEqual({
      client: { kind: "none" },
      questionOpen: false,
    });
  });
});
