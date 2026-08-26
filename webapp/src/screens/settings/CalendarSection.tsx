/**
 * Calendar settings (Phase 11, Task 5).
 *
 * The two repair tools live here rather than on the dashboard: they are
 * things you reach for when something looks wrong, not part of the
 * daily loop. Both say what they will do before they do it, because
 * both touch every event the user has.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData, useServices } from "../../lib/app-context.tsx";
import {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  requestCalendarCode,
} from "../../lib/google-signin.ts";
import { Button, SettingGroup, SettingRow, Select, Toggle } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

/** Offered reminder times. A free-text box invites "90000" and a
 *  validation error; these are the intervals people actually use. */
const REMINDER_CHOICES = [
  { value: 10, label: "10 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 120, label: "2 hours before" },
  { value: 240, label: "4 hours before" },
  { value: 1440, label: "1 day before" },
];

export function CalendarSection() {
  const { settings, update, isSaving } = useSettings();
  const data = useData();
  const { authApi } = useServices();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["calendar-status"],
    queryFn: () => data.getCalendarStatus(),
  });

  const resync = useMutation({
    mutationFn: () => data.calendarResync(),
    onSuccess: () =>
      setNotice(
        "Every gig will be reconsidered on the next sync — within 15 minutes, or tap Sync now on the dashboard.",
      ),
    onError: () => setNotice("Couldn't queue the resync. Try again."),
  });

  const isInsufficientScope = (e: unknown): boolean =>
    e instanceof Error && e.message.includes("reconnect-required");

  /**
   * Making the dedicated calendar, including consent if the grant is
   * too narrow — the same shape `AvailabilitySection` uses for the
   * freebusy grant, and for the same reason.
   *
   * `POST /calendars` is permitted by none of the scopes connecting
   * asks for, so this feature could never succeed on a first attempt.
   * The old handler caught that 409 and told the user to "disconnect
   * and reconnect", but reconnecting re-requests `calendar.events`, so
   * the next attempt failed identically and the advice was a circle.
   *
   * Asking for `calendar.app.created` is the actual fix, and it is
   * asked for HERE rather than added to the connect flow because it is
   * only needed by users who want a separate calendar — bundling it
   * into connecting would show every user a broader consent screen for
   * a feature most never touch.
   */
  const dedicated = useMutation({
    mutationFn: async () => {
      try {
        return { outcome: "created" as const, result: await data.createDedicatedCalendar() };
      } catch (e) {
        if (!isInsufficientScope(e)) throw e;
      }

      const { googleClientId } = await authApi.getConfig();
      if (googleClientId === "") return { outcome: "unavailable" as const };

      const code = await requestCalendarCode(googleClientId, [
        CALENDAR_EVENTS_SCOPE,
        CALENDAR_APP_CREATED_SCOPE,
      ]);
      await data.connectCalendar(code);

      // Verify rather than assume, for the reason AvailabilitySection
      // gives: a consent screen can be dismissed with a partial grant,
      // and a second `reconnect-required` means exactly that. Retried
      // once and only once — a loop here is the bug this replaces.
      try {
        return { outcome: "created" as const, result: await data.createDedicatedCalendar() };
      } catch (e) {
        if (isInsufficientScope(e)) return { outcome: "declined" as const };
        throw e;
      }
    },
    onSuccess: (outcome) => {
      if (outcome.outcome !== "created") {
        setNotice(
          outcome.outcome === "declined"
            ? "Permission to create a calendar wasn't granted, so nothing changed. Your gigs still go to the calendar you're using now."
            : "Couldn't reach Google just now. Nothing changed; try again in a moment.",
        );
        return;
      }
      const { result } = outcome;
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setNotice(
        result.failed > 0
          ? `Created. ${result.removed} old event(s) moved, but ${result.failed} couldn't be removed from your previous calendar — delete those by hand.`
          : `Created. Your gigs will appear on the new "Gigsy" calendar; ${result.removed} old event(s) were removed from the previous one.`,
      );
    },
    onError: () => setNotice("Couldn't create the calendar."),
  });

  if (settings === undefined) return null;

  const connected = status.data?.connected === true;
  const onDedicated = settings.calendarTargetId !== "primary";

  return (
    <SettingGroup
      title="Calendar"
      description="Only confirmed gigs with a date go to Google Calendar. Leads never do."
      data-testid="settings-calendar"
    >
      <SettingRow
        label="Prefix event titles"
        description={`Shows "Gigsy: Acme — Pier 39" so your gigs stand out among personal entries. Costs some title width on a phone.`}
        htmlFor="set-prefix"
        control={
          <Toggle
            id="set-prefix"
            data-testid="toggle-prefix"
            checked={settings.calendarTitlePrefix}
            disabled={isSaving}
            onChange={(next) => update({ calendarTitlePrefix: next })}
          />
        }
      />

      <SettingRow
        label="Use my calendar's own reminders"
        description="Leave your existing calendar defaults alone instead of adding ours on top."
        htmlFor="set-usedefault"
        control={
          <Toggle
            id="set-usedefault"
            data-testid="toggle-default-reminder"
            checked={settings.calendarUseDefaultReminder}
            disabled={isSaving}
            onChange={(next) => update({ calendarUseDefaultReminder: next })}
          />
        }
      />

      {!settings.calendarUseDefaultReminder && (
        <SettingRow
          label="Remind me"
          description="Gigs mean travel, so every event carries its own reminder."
          htmlFor="set-reminder"
          control={
            <Select
              id="set-reminder"
              data-testid="select-reminder"
              value={String(settings.calendarReminderMinutes)}
              disabled={isSaving}
              onChange={(e) =>
                update({ calendarReminderMinutes: Number(e.target.value) })
              }
            >
              {REMINDER_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          }
        />
      )}

      <SettingRow
        label="Separate Gigsy calendar"
        description={
          onDedicated
            ? "Your gigs go to a dedicated Gigsy calendar, which you can hide or share on its own."
            : "Keep work off your main calendar, so you can hide or share it separately. Existing events are moved."
        }
        control={
          onDedicated ? (
            <span className="text-xs text-emerald-700" data-testid="dedicated-on">
              In use
            </span>
          ) : (
            <Button
              variant="soft"
              data-testid="create-dedicated"
              disabled={!connected || dedicated.isPending}
              onClick={() => {
                setNotice(null);
                dedicated.mutate();
              }}
            >
              {dedicated.isPending ? "Creating…" : "Create"}
            </Button>
          )
        }
      />

      <SettingRow
        label="Re-sync everything"
        description="Reconsiders every gig on the next sync, not just recent changes. Use this if your calendar looks wrong or incomplete."
        control={
          <Button
            variant="ghost"
            data-testid="force-resync"
            disabled={!connected || resync.isPending}
            onClick={() => {
              setNotice(null);
              resync.mutate();
            }}
          >
            {resync.isPending ? "Queueing…" : "Re-sync"}
          </Button>
        }
      />

      {!connected && (
        <p className="pt-3 text-xs text-amber-700" data-testid="calendar-not-connected">
          Connect Google Calendar from the dashboard first.
        </p>
      )}
      {notice !== null && (
        <p className="pt-3 text-xs text-slate-600" data-testid="calendar-notice">
          {notice}
        </p>
      )}
    </SettingGroup>
  );
}
