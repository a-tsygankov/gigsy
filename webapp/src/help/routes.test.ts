import { describe, expect, it } from "vitest";
import { allowedRoutes, matchesRoute } from "./routes.ts";
import { HelpTarget } from "./targets.ts";
import type { HelpScenario } from "./types.ts";

describe("matchesRoute", () => {
  it("matches a literal pattern exactly", () => {
    expect(matchesRoute("/gigs", "/gigs")).toBe(true);
    expect(matchesRoute("/gigs", "/gigs/abc")).toBe(false);
    expect(matchesRoute("/gigs", "/")).toBe(false);
  });

  it("does not match a longer literal that merely starts the same", () => {
    // The reason this is a segment comparison and not `startsWith`.
    expect(matchesRoute("/gigs", "/gigsy")).toBe(false);
  });

  it("matches exactly one segment per :param", () => {
    expect(matchesRoute("/gigs/:id", "/gigs/abc")).toBe(true);
    expect(matchesRoute("/gigs/:id", "/gigs/abc/edit")).toBe(false);
    expect(matchesRoute("/gigs/:id", "/gigs")).toBe(false);
  });

  it("treats a param as required, not optional", () => {
    expect(matchesRoute("/gigs/:id", "/gigs/")).toBe(false);
  });

  it("handles more than one param", () => {
    expect(matchesRoute("/a/:x/b/:y", "/a/1/b/2")).toBe(true);
    expect(matchesRoute("/a/:x/b/:y", "/a/1/c/2")).toBe(false);
  });
});

const base: HelpScenario = {
  id: "s",
  title: "S",
  category: "gigs",
  startRoute: "/gigs",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.GigList,
      description: "Here.",
    },
  ],
};

describe("allowedRoutes", () => {
  it("is just the start route when nothing navigates", () => {
    expect(allowedRoutes(base, "/somewhere")).toEqual(["/gigs"]);
  });

  it("falls back to the given pathname when the scenario has no startRoute", () => {
    const { startRoute: _unused, ...noStart } = base;
    expect(allowedRoutes(noStart, "/somewhere")).toEqual(["/somewhere"]);
  });

  it("includes a navigate step's route", () => {
    const scenario: HelpScenario = {
      ...base,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap one.",
        },
      ],
    };
    expect(allowedRoutes(scenario, "/somewhere")).toEqual(["/gigs", "/gigs/:id"]);
  });

  it("reaches a navigate step nested inside a branch", () => {
    // The only place record-work's own navigate step lives, so this is
    // the case that actually matters.
    const scenario: HelpScenario = {
      ...base,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "showing",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "/gigs/:id",
                  description: "Tap one.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(allowedRoutes(scenario, "/somewhere")).toEqual(["/gigs", "/gigs/:id"]);
  });
});
