import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthState, useData, useServices } from "../lib/app-context.tsx";
import {
  currentSubscription,
  pushAvailability,
  subscribe,
  unsubscribe,
  type PushUnavailable,
} from "../lib/push.ts";
import { fetchTierVersions } from "../lib/versions.ts";
import { AppHeader, Button, Card, SectionHeading } from "../components/index.ts";
import { AppearanceSection } from "./settings/AppearanceSection.tsx";
import { AvailabilitySection } from "./settings/AvailabilitySection.tsx";
import { AvailabilityLinkSection } from "./settings/AvailabilityLinkSection.tsx";
import { BusinessSection } from "./settings/BusinessSection.tsx";
import { CalendarSection } from "./settings/CalendarSection.tsx";
import { CaptureSection } from "./settings/CaptureSection.tsx";
import { GigDefaultsSection } from "./settings/GigDefaultsSection.tsx";
import { NudgeSection } from "./settings/NudgeSection.tsx";
import { useSettings } from "./settings/useSettings.ts";

/** Why push isn't on offer, in words that say what to do about it. */
const UNAVAILABLE_COPY: Record<PushUnavailable, string> = {
  "not-installed":
    "On iPhone, notifications need Gigsy added to your home screen — tap Share, then Add to Home Screen, and open it from there.",
  unsupported: "This browser can't do notifications.",
  denied:
    "Notifications are blocked for Gigsy. Turn them back on in your browser or system settings, then come back.",
  "not-configured": "Notifications aren't switched on for this deployment yet.",
};

/** Reminders for the work a calendar can't hold: leads going cold and
 * invoices going unpaid (docs/plan.md §13, Phase 10). */
function NotificationsSection() {
  const data = useData();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<
    PushUnavailable | "available" | null
  >(null);

  useEffect(() => setAvailability(pushAvailability()), []);

  const config = useQuery({
    queryKey: ["push-config"],
    queryFn: () => data.getPushConfig(),
    retry: false,
  });

  const existing = useQuery({
    queryKey: ["push-subscription"],
    queryFn: () => currentSubscription(),
    retry: false,
  });

  const enable = useMutation({
    mutationFn: async () => {
      const { enabled, publicKey } = await data.getPushConfig();
      if (!enabled) throw new Error(UNAVAILABLE_COPY["not-configured"]);
      const subscription = await subscribe(publicKey);
      await data.savePushSubscription(subscription);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["push-subscription"] }),
    onError: (e) =>
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? UNAVAILABLE_COPY.denied
          : e instanceof Error
            ? e.message
            : "Couldn't turn notifications on.",
      ),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribe();
      // Tell the server even if the browser had already forgotten it,
      // otherwise we'd keep pushing to a dead endpoint until the
      // service rejects it.
      if (endpoint !== null) await data.deletePushSubscription(endpoint);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["push-subscription"] }),
    onError: () => setError("Couldn't turn notifications off."),
  });

  const serverOff = config.data !== undefined && !config.data.enabled;
  const blocked =
    availability !== null && availability !== "available"
      ? UNAVAILABLE_COPY[availability]
      : serverOff
        ? UNAVAILABLE_COPY["not-configured"]
        : null;
  const subscribed = existing.data != null;

  return (
    <Card as="section" data-testid="settings-notifications" className="space-y-2">
      <p className="text-sm font-semibold text-slate-900">Notifications</p>
      <p className="text-xs text-slate-500">
        A nudge when a lead goes cold or an invoice stays unpaid — the work
        your calendar can't remind you about. At most one a day.
      </p>

      {blocked !== null ? (
        <p className="text-xs text-amber-700" data-testid="push-unavailable">
          {blocked}
        </p>
      ) : (
        <Button
          variant={subscribed ? "ghost" : "soft"}
          data-testid="push-toggle"
          disabled={enable.isPending || disable.isPending || existing.isPending}
          onClick={() => {
            setError(null);
            subscribed ? disable.mutate() : enable.mutate();
          }}
        >
          {enable.isPending || disable.isPending
            ? "Working…"
            : subscribed
              ? "Turn off notifications"
              : "Turn on notifications"}
        </Button>
      )}

      {subscribed && blocked === null && (
        <p className="text-xs text-emerald-700">On for this device.</p>
      )}
      {error !== null && <p className="text-xs text-red-600">{error}</p>}
    </Card>
  );
}

function AccountSection() {
  const { user } = useAuthState();
  const { auth } = useServices();

  return (
    <Card as="section" data-testid="settings-account" className="space-y-2">
      <p className="text-sm font-semibold text-slate-900">Account</p>
      <p className="text-xs text-slate-500" data-testid="settings-email">
        {user?.email ?? "Not signed in"}
      </p>
      <Button variant="ghost" onClick={() => void auth.signOut()}>
        Sign out
      </Button>
    </Card>
  );
}

/** Versions used to live only behind three taps on the wordmark;
 * someone reporting a problem shouldn't need to know a secret. */
function AboutSection() {
  const versions = useQuery({
    queryKey: ["versions"],
    queryFn: () => fetchTierVersions(),
  });

  return (
    <Card as="section" data-testid="settings-about" className="space-y-1">
      <p className="text-sm font-semibold text-slate-900">App</p>
      {versions.data === undefined ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : (
        <dl className="text-xs text-slate-500">
          {Object.entries(versions.data).map(([tier, version]) => (
            <div key={tier} className="flex justify-between py-0.5">
              <dt className="capitalize">{tier}</dt>
              {/* null means the worker was unreachable — say that
                  rather than showing an empty row. */}
              <dd className="tabular-nums">{version ?? "offline"}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

export function Settings() {
  const { isLoading, loadError, saveError } = useSettings();

  return (
    <>
      <AppHeader title="Settings" />
      <main className="mx-auto max-w-lg space-y-4 p-4 pb-24">
        {/* One banner for the whole screen: a failed save is a failed
            save whichever control caused it, and thirteen inline error
            slots would be thirteen places to forget one. */}
        {saveError !== null && (
          <p
            className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600"
            data-testid="settings-save-error"
          >
            That change didn't save, so it's been put back. Check your
            connection and try again.
          </p>
        )}

        <SectionHeading>Preferences</SectionHeading>

        {/* Device-local, so it renders even when the server settings
            can't be reached. */}
        <AppearanceSection />

        {loadError !== null ? (
          <Card as="section" data-testid="settings-load-error">
            <p className="text-sm text-slate-600">
              Settings couldn't be loaded. They live on the server, so this
              needs a connection.
            </p>
          </Card>
        ) : isLoading ? (
          <Card as="section" data-testid="settings-loading">
            <p className="text-sm text-slate-400">Loading…</p>
          </Card>
        ) : (
          <>
            <CalendarSection />
            <GigDefaultsSection />
            <BusinessSection />
            <NudgeSection />
          </>
        )}

        {/* Its own heading: this is the one group that decides what
            people outside the app can see, and burying it among
            personal preferences would understate that. */}
        <SectionHeading>Sharing your availability</SectionHeading>
        {loadError === null && !isLoading && <AvailabilitySection />}
        <AvailabilityLinkSection />

        <SectionHeading>Capture</SectionHeading>
        <CaptureSection />

        <SectionHeading>Notifications on this device</SectionHeading>
        <NotificationsSection />

        <SectionHeading>Account</SectionHeading>
        <AccountSection />
        <AboutSection />
      </main>
    </>
  );
}
