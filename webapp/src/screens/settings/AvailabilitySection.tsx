/**
 * What the availability page says about you (Phase 12, Task 5).
 *
 * These are the only settings that shape what an unauthenticated
 * stranger sees, so each one says what it exposes rather than just
 * what it does.
 *
 * The calendar toggle is the delicate one. Reading a calendar needs a
 * scope the connect flow never asked for, so turning it on may require
 * fresh consent — and the plan is explicit that this must be presented
 * as a choice, never slipped in. It also must NOT re-prompt when
 * Google is merely unreachable: an unexplained consent popup during an
 * outage is one the user declines, and then the feature looks broken.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useData, useServices } from "../../lib/app-context.tsx";
import {
  Button,
  Input,
  Select,
  SettingGroup,
  SettingRow,
  Toggle,
} from "../../components/index.ts";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  requestCalendarCode,
} from "../../lib/google-signin.ts";
import {
  END_OF_DAY_MINUTE,
  WEEKDAY_LABELS,
  describeWeek,
  setEdge,
  timeChoices,
  toggleDay,
  type WorkingWeek,
} from "../../lib/working-week.ts";
import { useSettings } from "./useSettings.ts";

const HORIZON_CHOICES = [1, 2, 4, 8, 12];
const MIN_SLOT_CHOICES = [30, 60, 90, 120, 240];

/** Every zone the runtime knows, so nobody is stuck on a near-miss.
 *  Older engines lack supportedValuesOf; fall back to just theirs. */
function zoneOptions(current: string): string[] {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set([current, detected, "UTC", ...all])].filter(Boolean);
}

export function AvailabilitySection() {
  const { settings, update, isSaving } = useSettings();
  const data = useData();
  const { authApi } = useServices();
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Turning the calendar on, including consent if the grant is too
   * narrow. Every branch either succeeds or explains itself — the one
   * unacceptable outcome is a toggle that flips back with no reason.
   */
  const enableCalendar = useMutation({
    mutationFn: async () => {
      const first = await data.checkCalendarFreeBusy();
      if (first.readable) return "ok" as const;
      if (first.reason === "not-connected") return "not-connected" as const;
      // Google is having a moment. Re-prompting for consent would be
      // the wrong fix and the user would decline a popup they did not
      // expect, so say what happened and change nothing.
      if (first.reason === "unavailable") return "unavailable" as const;

      const { googleClientId } = await authApi.getConfig();
      if (googleClientId === "") return "unavailable" as const;
      const code = await requestCalendarCode(googleClientId, [
        CALENDAR_EVENTS_SCOPE,
        CALENDAR_READONLY_SCOPE,
      ]);
      await data.connectCalendar(code);

      // Verify rather than assume: consent screens can be dismissed
      // with a partial grant, and believing otherwise would leave the
      // page quietly built on gigs alone while claiming otherwise.
      return (await data.checkCalendarFreeBusy()).readable
        ? ("ok" as const)
        : ("declined" as const);
    },
    onSuccess: (outcome) => {
      if (outcome === "ok") {
        update({ availabilityUseCalendar: true });
        setNotice("Your calendar is now included, so the page won't offer time you're already committed.");
        return;
      }
      setNotice(
        outcome === "not-connected"
          ? "Connect Google Calendar from the dashboard first."
          : outcome === "declined"
            ? "Permission wasn't granted, so your page will keep using Gigsy bookings alone — and will say so."
            : "Couldn't reach Google just now. Nothing changed; try again in a moment.",
      );
    },
    onError: () =>
      setNotice(
        "Permission wasn't granted, so your page will keep using Gigsy bookings alone — and will say so.",
      ),
  });

  if (settings === undefined) return null;

  const week = settings.availabilityWorkingWeek as WorkingWeek;
  const saveWeek = (next: WorkingWeek) => update({ availabilityWorkingWeek: next });
  const starts = timeChoices(false);
  const ends = timeChoices(true);
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <SettingGroup
      title="Availability"
      description="What the shareable link shows. Free time is worked out from your gigs — leads never count as busy."
      data-testid="settings-availability"
    >
      <SettingRow
        label="Name on the page"
        description="Shown as “Andrey's availability”. Leave it empty to stay anonymous — the page still works."
        htmlFor="set-avail-name"
        control={
          <Input
            id="set-avail-name"
            data-testid="input-avail-name"
            className="sm:w-48"
            maxLength={60}
            placeholder="Your name"
            defaultValue={settings.availabilityDisplayName ?? ""}
            disabled={isSaving}
            onBlur={(e) => {
              const value = e.target.value.trim();
              const next = value === "" ? null : value;
              if (next !== settings.availabilityDisplayName) {
                update({ availabilityDisplayName: next });
              }
            }}
          />
        }
      />

      <SettingRow
        label="Timezone"
        description="Every time on the page is shown in this zone and labelled with it, so someone in another country reads it correctly."
        htmlFor="set-avail-tz"
        control={
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <Select
              id="set-avail-tz"
              data-testid="select-avail-tz"
              className="sm:w-56"
              value={settings.availabilityTimeZone}
              disabled={isSaving}
              onChange={(e) => update({ availabilityTimeZone: e.target.value })}
            >
              {zoneOptions(settings.availabilityTimeZone).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
            {settings.availabilityTimeZone !== detected && (
              <Button
                variant="ghost"
                data-testid="use-device-tz"
                disabled={isSaving}
                onClick={() => update({ availabilityTimeZone: detected })}
              >
                Use {detected}
              </Button>
            )}
          </div>
        }
      />

      <div className="py-3" data-testid="avail-working-week">
        <p className="text-sm font-medium text-slate-900">Working hours</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {describeWeek(week)} Free time outside these hours is your evening, not
          availability.
        </p>
        <ul className="mt-3 space-y-2">
          {WEEKDAY_LABELS.map((name, index) => {
            const day = week[index] ?? null;
            return (
              <li key={name} className="flex flex-wrap items-center gap-2">
                <Toggle
                  id={`set-day-${index}`}
                  data-testid={`toggle-day-${index}`}
                  checked={day !== null}
                  disabled={isSaving}
                  onChange={(on) => saveWeek(toggleDay(week, index, on))}
                />
                <label
                  htmlFor={`set-day-${index}`}
                  className="w-20 shrink-0 text-sm text-slate-700"
                >
                  {name.slice(0, 3)}
                </label>
                {day === null ? (
                  <span className="text-xs text-slate-400">Off</span>
                ) : (
                  <>
                    <Select
                      aria-label={`${name} start`}
                      data-testid={`start-day-${index}`}
                      className="w-28"
                      value={String(day.startMinute)}
                      disabled={isSaving}
                      onChange={(e) =>
                        saveWeek(setEdge(week, index, "start", Number(e.target.value)))
                      }
                    >
                      {starts.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                    <span className="text-xs text-slate-400">to</span>
                    <Select
                      aria-label={`${name} end`}
                      data-testid={`end-day-${index}`}
                      className="w-28"
                      value={String(Math.min(day.endMinute, END_OF_DAY_MINUTE))}
                      disabled={isSaving}
                      onChange={(e) =>
                        saveWeek(setEdge(week, index, "end", Number(e.target.value)))
                      }
                    >
                      {ends.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <SettingRow
        label="How far ahead"
        description="An unbounded calendar invites scraping and answers a question nobody asked."
        htmlFor="set-avail-horizon"
        control={
          <Select
            id="set-avail-horizon"
            data-testid="select-avail-horizon"
            value={String(settings.availabilityHorizonWeeks)}
            disabled={isSaving}
            onChange={(e) => update({ availabilityHorizonWeeks: Number(e.target.value) })}
          >
            {HORIZON_CHOICES.map((w) => (
              <option key={w} value={w}>
                {w} week{w === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        }
      />

      <SettingRow
        label="Shortest slot worth showing"
        description="A twenty-minute hole between two gigs isn't a booking, so it isn't offered."
        htmlFor="set-avail-minslot"
        control={
          <Select
            id="set-avail-minslot"
            data-testid="select-avail-minslot"
            value={String(settings.availabilityMinSlotMinutes)}
            disabled={isSaving}
            onChange={(e) =>
              update({ availabilityMinSlotMinutes: Number(e.target.value) })
            }
          >
            {MIN_SLOT_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
              </option>
            ))}
          </Select>
        }
      />

      <SettingRow
        label="Use my Google Calendar too"
        description="Gigsy doesn't know about the dentist or a job booked elsewhere. With this on, your page won't offer time you're already committed — Gigsy reads only when you're busy, never what you're doing."
        htmlFor="set-avail-calendar"
        control={
          <Toggle
            id="set-avail-calendar"
            data-testid="toggle-avail-calendar"
            checked={settings.availabilityUseCalendar}
            disabled={isSaving || enableCalendar.isPending}
            onChange={(on) => {
              setNotice(null);
              if (!on) {
                update({ availabilityUseCalendar: false });
                return;
              }
              enableCalendar.mutate();
            }}
          />
        }
      />

      {notice !== null && (
        <p className="pt-3 text-xs text-slate-600" data-testid="availability-notice">
          {notice}
        </p>
      )}
    </SettingGroup>
  );
}
