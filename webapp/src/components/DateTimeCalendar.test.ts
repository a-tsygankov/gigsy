import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The split is a build-time property with no runtime symptom: import the
 * calendar statically from anywhere and react-day-picker plus date-fns
 * fold straight back into the main chunk, every screen pays for them
 * again, and every other test in this repo still passes — including the
 * ones that drive the picker. Nothing observes it but the build, so the
 * guard is on the imports themselves.
 */
describe("the calendar is only ever reached dynamically", () => {
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  const STATIC_IMPORT = /^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm;
  const CALENDAR = /DateTimeCalendar|ui\/calendar/;

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = dir + entry;
      if (statSync(full).isDirectory()) sourceFiles(full + "/", found);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
    }
    return found;
  }

  it("is imported statically by nothing but its own module", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      // The one file allowed to pull the calendar in: it IS the chunk.
      if (file.endsWith("DateTimeCalendar.tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
        if (CALENDAR.test(specifier!)) offenders.push(`${file} -> ${specifier!}`);
      }
    }
    expect(offenders, "a static import puts the calendar back in the main chunk").toEqual([]);
  });

  it("is reached from DateTimeField through import()", () => {
    const source = readFileSync(srcDir + "components/DateTimeField.tsx", "utf8");
    expect(source).toMatch(/import\("\.\/DateTimeCalendar\.tsx"\)/);
  });
});
