import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { clientLogBuffer, type LogEntry } from "../lib/logger.ts";
import { fetchTierVersions, type TierVersions } from "../lib/versions.ts";
import { settings, type AppSettings } from "../lib/settings.ts";
import { LogList } from "./LogList.tsx";

/**
 * Data access is injected (defaulted for the app, stubbed in tests)
 * so the component stays presentational — it never knows where
 * versions or logs come from.
 */
export interface ConsoleDataSource {
  getVersions(): Promise<TierVersions>;
  /** null = worker unreachable (vs [] = reachable but empty). */
  getWorkerLogs(limit: number): Promise<LogEntry[] | null>;
  getClientLogs(): LogEntry[];
  getSettings(): AppSettings;
}

/** Build the app's data source around the authed ApiClient —
 * /api/debug/* is JWT-guarded, so worker logs need the bearer token
 * (signed out they degrade to the "unreachable" marker). */
export function makeConsoleDataSource(api: ApiClient): ConsoleDataSource {
  return {
    getVersions: () => fetchTierVersions(),
    getWorkerLogs: async (limit) => {
      try {
        return (await api.getDebugLogs(limit)).entries as LogEntry[];
      } catch {
        return null;
      }
    },
    getClientLogs: () => clientLogBuffer.toArray(),
    getSettings: () => settings.get(),
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function VersionRow({ tier, value, testId }: { tier: string; value: string; testId: string }) {
  return (
    <div className="flex justify-between font-mono text-xs">
      <span className="text-slate-500">{tier}</span>
      <span data-testid={testId} className="text-slate-800">
        {value}
      </span>
    </div>
  );
}

interface Props {
  onClose: () => void;
  dataSource: ConsoleDataSource;
}

/** The hidden debug console — opened by 3 taps on the app logo.
 * Shows tier versions (on open), app settings, and the client/worker
 * log feeds. Every remote value degrades to an explicit marker so the
 * console works fully offline. */
export function HiddenConsole({ onClose, dataSource }: Props) {
  const [versions, setVersions] = useState<TierVersions | null>(null);
  const [workerLogs, setWorkerLogs] = useState<LogEntry[] | null>(null);
  const [clientLogs, setClientLogs] = useState<LogEntry[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => dataSource.getSettings());

  const refresh = useCallback(async () => {
    setClientLogs(dataSource.getClientLogs());
    setAppSettings(dataSource.getSettings());
    // Versions first — the console shows them the moment it opens.
    setVersions(await dataSource.getVersions());
    setWorkerLogs(await dataSource.getWorkerLogs(dataSource.getSettings().workerLogLimit));
  }, [dataSource]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-testid="hidden-console"
      className="fixed inset-x-0 bottom-0 z-50 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-slate-300 bg-white p-4 shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-800">Debug console</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
          >
            Refresh
          </button>
          <button
            type="button"
            data-testid="console-close"
            onClick={onClose}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
          >
            Close
          </button>
        </div>
      </div>

      <Section title="Versions">
        {versions === null ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-0.5">
            <VersionRow tier="client" value={versions.client} testId="version-client" />
            <VersionRow
              tier="worker"
              value={versions.worker ?? "unreachable"}
              testId="version-worker"
            />
            <VersionRow
              tier="schema"
              value={
                versions.schema ?? (versions.worker === null ? "unreachable" : "none applied")
              }
              testId="version-schema"
            />
            <VersionRow tier="env" value={versions.env ?? "—"} testId="version-env" />
          </div>
        )}
      </Section>

      <Section title="Settings">
        <div data-testid="console-settings" className="space-y-0.5 font-mono text-xs">
          {Object.entries(appSettings).map(([key, value]) => (
            <div key={key} className="flex justify-between">
              <span className="text-slate-500">{key}</span>
              <span className="text-slate-800">{String(value)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Client logs">
        <div data-testid="client-logs">
          <LogList entries={clientLogs} emptyMessage="No client logs yet." />
        </div>
      </Section>

      <Section title="Worker logs">
        <div data-testid="worker-logs">
          {workerLogs === null ? (
            <p className="text-xs text-slate-500">Worker unreachable.</p>
          ) : (
            <LogList entries={workerLogs} emptyMessage="No worker logs yet." />
          )}
        </div>
      </Section>
    </div>
  );
}
