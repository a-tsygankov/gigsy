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
import { useData } from "../../lib/app-context.tsx";
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

  const dedicated = useMutation({
    mutationFn: () => data.createDedicatedCalendar(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setNotice(
        result.failed > 0
          ? `Created. ${result.removed} old event(s) moved, but ${result.failed} couldn't be removed from your previous calendar — delete those by hand.`
          : `Created. Your gigs will appear on the new "Gigsy" calendar; ${result.removed} old event(s) were removed from the previous one.`,
      );
    },
    onError: (e) =>
      setNotice(
        e instanceof Error && e.message.includes("reconnect-required")
          ? "Google needs broader permission to create a calendar. Disconnect and reconnect, then try again."
          : "Couldn't create the calendar.",
      ),
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
