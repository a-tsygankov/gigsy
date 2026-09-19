/**
 * The page and the policy that governs it, held to each other.
 *
 * Production serves index.html under the Content-Security-Policy in
 * functions/_middleware.ts — `script-src 'self'` with no inline
 * allowance — and `vite dev` serves it under none. That gap is how an
 * inline theme script sat in this page for months, working on every
 * developer machine and blocked on every real launch. These checks
 * read the two files as text, so the gap closes at unit-test speed
 * rather than on a phone.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Comments are not served to the parser's script scanner, and the
// page's own comment explains this rule using the tag it forbids.
const INDEX = read("../../index.html").replace(/<!--[\s\S]*?-->/g, "");
const MIDDLEWARE = read("../../functions/_middleware.ts");

describe("index.html under the production CSP", () => {
  it("has no inline script — the CSP would block it and nothing would say so", () => {
    // Every <script> must carry a src. A bare "<script>" is the tag
    // that shipped blocked; "<script type=module>" without src would
    // be the same mistake in newer clothes.
    const tags = INDEX.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/\bsrc=/);
  });

  it("has no inline event handlers either", () => {
    expect(INDEX).not.toMatch(/\son[a-z]+=/i);
  });

  it("loads the theme boot script from a same-origin file, in <head>, before the app", () => {
    const head = INDEX.slice(0, INDEX.indexOf("</head>"));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
    // A classic script, not a module: modules are deferred and would
    // run after first paint, which is the flash this exists to prevent.
    expect(head).not.toMatch(/<script[^>]*type="module"[^>]*theme-boot/);
  });

  it("is served under a script-src that admits 'self' and nothing inline", () => {
    const scriptSrc = /"script-src ([^"]+)"/.exec(MIDDLEWARE)?.[1] ?? "";
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // If a hash or nonce is ever added, the first test above is what
    // should change — deliberately, with the reason written down.
    expect(scriptSrc).not.toMatch(/'(sha256|nonce)-/);
  });

  it("declares a theme-color for the boot script to overwrite", () => {
    expect(INDEX).toContain('<meta name="theme-color" content="#f8fafc" />');
  });
});
