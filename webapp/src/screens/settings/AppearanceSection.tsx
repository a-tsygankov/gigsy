/**
 * Theme selection (Phase 11, Task 4).
 *
 * The only setting on this screen that stays on the device. Everything
 * else is who you are; this is where you are — dark on a phone at a
 * night shift, light on a laptop in daylight. Syncing it would work
 * against the user, so it never leaves localStorage.
 *
 * Segmented rather than a toggle, because "System" is a real answer and
 * the default one: a phone that dims itself at night should take the
 * app with it.
 */
import { useEffect, useState } from "react";
import { SettingGroup, SettingRow } from "../../components/index.ts";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ThemeChoice,
} from "../../lib/theme.ts";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function AppearanceSection() {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    readStoredTheme(window.localStorage),
  );

  // Follow the OS while — and only while — the choice is "system". A
  // phone switching at sunset should carry the app with it without a
  // reload; an explicit choice must not be overridden by the same event.
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const sync = () => applyTheme(document, resolveTheme(choice, media.matches));
    sync();
    if (choice !== "system") return;
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [choice]);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    storeTheme(window.localStorage, next);
    // Applied here as well as in the effect so the change is instant
    // rather than waiting a render.
    applyTheme(document, resolveTheme(next, window.matchMedia(DARK_QUERY).matches));
  };

  return (
    <SettingGroup title="Appearance" data-testid="settings-appearance">
      <SettingRow
        label="Theme"
        description="Stays on this device — your phone can be dark while your laptop isn't."
        control={
          <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex rounded-xl bg-slate-100 p-0.5"
          >
            {CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={choice === c.value}
                data-testid={`theme-${c.value}`}
                onClick={() => pick(c.value)}
                className={[
                  "min-h-[38px] rounded-[10px] px-3 text-xs font-medium transition-colors",
                  choice === c.value
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500",
                ].join(" ")}
              >
                {c.label}
              </button>
            ))}
          </div>
        }
      />
    </SettingGroup>
  );
}
