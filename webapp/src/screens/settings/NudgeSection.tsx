/**
 * What the nudges say and when (Phase 11).
 *
 * The Phase 10 opt-in decides whether this device can receive anything;
 * these decide whether there is anything to receive. Both matter: a
 * subscribed device with every nudge off should stay quiet.
 *
 * The thresholds were constants in the push cron, which is exactly the
 * sort of number one person finds nagging and another finds too quiet.
 */
import { SettingGroup, SettingRow, Select, Toggle } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

const DAY_CHOICES = [3, 5, 7, 10, 14, 21, 30, 45, 60];

export function NudgeSection() {
  const { settings, update, isSaving } = useSettings();
  if (settings === undefined) return null;

  const off = !settings.notificationsEnabled;

  return (
    <SettingGroup
      title="Reminders"
      description="At most one a day, whatever is waiting."
      data-testid="settings-nudges"
    >
      <SettingRow
        label="Send me reminders"
        description="Master switch. Off means nothing is sent, whatever the settings below say."
        htmlFor="set-notifications"
        control={
          <Toggle
            id="set-notifications"
            data-testid="toggle-notifications"
            checked={settings.notificationsEnabled}
            disabled={isSaving}
            onChange={(next) => update({ notificationsEnabled: next })}
          />
        }
      />

      <SettingRow
        label="Leads going cold"
        description="A lead you haven't touched in a while is usually a lead you've forgotten."
        htmlFor="set-stale"
        control={
          <Toggle
            id="set-stale"
            data-testid="toggle-stale-leads"
            checked={settings.nudgeStaleLeadsEnabled}
            disabled={isSaving || off}
            onChange={(next) => update({ nudgeStaleLeadsEnabled: next })}
          />
        }
      />

      {settings.nudgeStaleLeadsEnabled && !off && (
        <SettingRow
          label="Cold after"
          description="How long a lead can sit untouched before it counts as going cold."
          htmlFor="set-stale-days"
          control={
            <Select
              id="set-stale-days"
              data-testid="select-stale-days"
              value={String(settings.nudgeStaleLeadDays)}
              disabled={isSaving}
              onChange={(e) => update({ nudgeStaleLeadDays: Number(e.target.value) })}
            >
              {DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          }
        />
      )}

      <SettingRow
        label="Unpaid work"
        description="A completed gig that hasn't been paid for is money you're owed."
        htmlFor="set-unpaid"
        control={
          <Toggle
            id="set-unpaid"
            data-testid="toggle-unpaid"
            checked={settings.nudgeUnpaidEnabled}
            disabled={isSaving || off}
            onChange={(next) => update({ nudgeUnpaidEnabled: next })}
          />
        }
      />

      {settings.nudgeUnpaidEnabled && !off && (
        <SettingRow
          label="Chase after"
          description="How long to wait after a gig before treating payment as overdue."
          htmlFor="set-unpaid-days"
          control={
            <Select
              id="set-unpaid-days"
              data-testid="select-unpaid-days"
              value={String(settings.nudgeUnpaidDays)}
              disabled={isSaving}
              onChange={(e) => update({ nudgeUnpaidDays: Number(e.target.value) })}
            >
              {DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          }
        />
      )}
    </SettingGroup>
  );
}
