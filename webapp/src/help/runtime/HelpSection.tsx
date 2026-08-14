/**
 * Where help lives: a Settings group, not a header button. At 375px the
 * header already carries wordmark, title, sync chip and the Settings
 * link, the tab bar is at its five-tab limit, and Gigsy has no icon set
 * to shrink an entry point into (docs/design-system.md).
 */
import { SettingGroup } from "../../components/index.ts";
import { HelpMenu } from "./HelpMenu.tsx";

export function HelpSection() {
  return (
    <SettingGroup
      title="Help"
      description="Step-by-step walkthroughs over the real screens."
      data-testid="settings-help"
    >
      <HelpMenu />
    </SettingGroup>
  );
}
