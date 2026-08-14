/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { detectHelpEnvironment } from "./environment.ts";

const IOS_SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const IOS_SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const IOS_SAFARI_IPOD =
  "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Mobile Safari/537.36";

const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// Edge's own UA still carries "Chrome/" for site-compatibility purposes, so
// this string matches a naive Chrome regex too — it exists specifically to
// prove that the Edge check runs first.
const DESKTOP_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";

const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0";

describe("detectHelpEnvironment", () => {
  it("detects iOS Safari on an iPhone", () => {
    expect(detectHelpEnvironment(IOS_SAFARI_IPHONE)).toBe("ios-safari");
  });

  it("detects iOS Safari on an iPad", () => {
    expect(detectHelpEnvironment(IOS_SAFARI_IPAD)).toBe("ios-safari");
  });

  it("detects iOS Safari on an iPod", () => {
    expect(detectHelpEnvironment(IOS_SAFARI_IPOD)).toBe("ios-safari");
  });

  it("detects Android Chrome", () => {
    expect(detectHelpEnvironment(ANDROID_CHROME)).toBe("android-chrome");
  });

  it("detects desktop Chrome", () => {
    expect(detectHelpEnvironment(DESKTOP_CHROME)).toBe("desktop-chrome");
  });

  it("detects desktop Edge, not desktop Chrome, even though Edge's UA contains \"Chrome\"", () => {
    // The ordering trap: if the Chrome check ran first, this UA would
    // wrongly resolve to "desktop-chrome" since it contains "Chrome/" too.
    expect(detectHelpEnvironment(DESKTOP_EDGE)).toBe("desktop-edge");
  });

  it("falls back for a browser that is neither Chrome nor Edge nor iOS", () => {
    expect(detectHelpEnvironment(DESKTOP_FIREFOX)).toBe("fallback");
  });

  it("falls back for an empty user agent, never guessing", () => {
    expect(detectHelpEnvironment("")).toBe("fallback");
  });
});
