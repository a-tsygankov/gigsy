/**
 * Defaults for new gigs, and how money is shown (Phase 11).
 *
 * Both are cases where the app previously made a choice on the user's
 * behalf and never admitted it: duration was always blank, and money
 * was always dollars. The delivery switch (2026-09-20 optional-delivery
 * design) is the third of the same kind: every completed gig used to be
 * treated as waiting to be handed over, which is right for a
 * photographer and wrong for a brand ambassador.
 */
import { SettingGroup, SettingRow, Select, Toggle } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

/** Shifts people actually work. "No default" first, because prefilling
 *  a wrong duration is worse than prefilling none. */
const DURATION_CHOICES = [
  { value: "", label: "No default" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
  { value: "240", label: "4 hours" },
  { value: "480", label: "8 hours" },
];

/** Kept short deliberately: a full ISO 4217 list is 180 entries of
 *  noise. The server accepts any valid code, so this grows on demand
 *  rather than by anticipation. */
const CURRENCY_CHOICES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY"];

export function GigDefaultsSection() {
  const { settings, update, isSaving } = useSettings();
  if (settings === undefined) return null;

  return (
    <SettingGroup title="Gigs" data-testid="settings-gigs">
      <SettingRow
        label="Default duration"
        description="Prefills new gigs with your usual shift. You can always change it per gig."
        htmlFor="set-duration"
        control={
          <Select
            id="set-duration"
            data-testid="select-duration"
            value={
              settings.defaultGigDurationMinutes === null
                ? ""
                : String(settings.defaultGigDurationMinutes)
            }
            disabled={isSaving}
            onChange={(e) =>
              update({
                defaultGigDurationMinutes:
                  e.target.value === "" ? null : Number(e.target.value),
              })
            }
          >
            {DURATION_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        }
      />

      <SettingRow
        label="Currency"
        description="How amounts are displayed. It doesn't convert anything — existing figures keep their value."
        htmlFor="set-currency"
        control={
          <Select
            id="set-currency"
            data-testid="select-currency"
            value={settings.currency}
            disabled={isSaving}
            onChange={(e) => update({ currency: e.target.value })}
          >
            {CURRENCY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        }
      />

      {/* A DEFAULT, and the description has to say so: this does not
          reach back into clients that already exist. Each client keeps
          its own switch (ClientEdit.tsx), seeded from this one at
          creation. It is also the answer for a gig with no client at
          all — lib/gig-delivery.ts — which is the one place it acts
          directly rather than through a client. */}
      <SettingRow
        label="My clients expect delivery afterwards"
        description="Sets the switch on each new client. Turn it on per client for the ones whose work is handed over — photo shoots, edits, anything with files to send."
        htmlFor="set-clients-delivery"
        data-testid="settings-clients-delivery"
        control={
          <Toggle
            id="set-clients-delivery"
            data-testid="toggle-clients-delivery"
            checked={settings.clientsExpectDelivery}
            disabled={isSaving}
            onChange={(next) => update({ clientsExpectDelivery: next })}
          />
        }
      />
    </SettingGroup>
  );
}
