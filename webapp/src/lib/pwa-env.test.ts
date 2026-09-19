import { describe, expect, it } from "vitest";
import { browserEnv, isIos, isStandalone } from "./pwa-env.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15";

describe("pwa-env", () => {
  it("knows an iPhone, an iPad and an iPod from everything else", () => {
    expect(isIos({ userAgent: IPHONE })).toBe(true);
    expect(isIos({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" })).toBe(true);
    expect(isIos({ userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/150" })).toBe(false);
    expect(isIos({ userAgent: "Mozilla/5.0 (Macintosh) Safari/605" })).toBe(false);
  });

  it("reads standalone off either signal — Safari's own flag or the media query", () => {
    const query = (matches: boolean) => (q: string) => ({
      matches: q === "(display-mode: standalone)" && matches,
    });
    expect(isStandalone({ userAgent: IPHONE, standalone: true, matchMedia: query(false) })).toBe(true);
    expect(isStandalone({ userAgent: IPHONE, matchMedia: query(true) })).toBe(true);
    expect(isStandalone({ userAgent: IPHONE, standalone: false, matchMedia: query(false) })).toBe(false);
    expect(isStandalone({ userAgent: IPHONE, matchMedia: query(false) })).toBe(false);
  });

  it("wraps a window without carrying an undefined standalone flag", () => {
    const win = {
      navigator: { userAgent: "UA" },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window;
    const env = browserEnv(win);
    expect(env.userAgent).toBe("UA");
    expect("standalone" in env).toBe(false);
    expect(env.matchMedia("(display-mode: standalone)").matches).toBe(false);
  });
});
