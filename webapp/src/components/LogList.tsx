import type { LogEntry } from "../lib/logger.ts";

const LEVEL_STYLES: Record<LogEntry["level"], string> = {
  info: "text-slate-500",
  warn: "text-amber-600",
  error: "text-red-600",
};

interface Props {
  entries: LogEntry[];
  emptyMessage: string;
}

/** Reusable log renderer — the client and worker feeds share one
 * LogEntry shape, so one component renders both. */
export function LogList({ entries, emptyMessage }: Props) {
  if (entries.length === 0) {
    return <p className="text-xs text-slate-500">{emptyMessage}</p>;
  }
  return (
    <ul className="space-y-1 font-mono text-xs">
      {entries.map((entry, i) => (
        <li key={`${entry.ts}-${i}`} className="flex gap-2">
          <span className="shrink-0 text-slate-400">
            {new Date(entry.ts).toLocaleTimeString()}
          </span>
          <span className={`shrink-0 uppercase ${LEVEL_STYLES[entry.level]}`}>
            {entry.level}
          </span>
          <span className="break-all text-slate-700">
            {entry.msg}
            {entry.data ? ` ${JSON.stringify(entry.data)}` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
