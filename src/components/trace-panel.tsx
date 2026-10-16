import type { DataMode, RunStatus, TraceEvent } from "@/lib/contracts";
import {
  buildRoutePath,
  buildTraceRows,
  dataModeBadgeText,
  totalElapsedMs,
} from "@/components/trace-view-model";

// Collapsed by default. A native details element is keyboard accessible with no
// script. The events come from the run response, and the download uses the
// existing trace route.
export function TracePanel({
  runId,
  events,
  status,
  dataMode,
}: {
  runId: string;
  events: readonly TraceEvent[];
  status: RunStatus;
  dataMode: DataMode;
}) {
  const path = buildRoutePath(events, status);
  const rows = buildTraceRows(events);
  const href = `/api/trace/${encodeURIComponent(runId)}`;

  return (
    <details className="trace-panel">
      <summary>
        Execution trace · {events.length} {events.length === 1 ? "step" : "steps"}
      </summary>

      <ol className="route-path" aria-label="Route path">
        {path.map((label, index) => (
          <li key={`${index}-${label}`}>{label}</li>
        ))}
      </ol>

      <div className="trace-meta">
        <span className="trace-chip">Total {totalElapsedMs(events)} ms</span>
        <span className="trace-chip">{dataModeBadgeText(dataMode)}</span>
        <a className="trace-download" href={href} download>
          Download trace JSON
        </a>
      </div>

      <ol className="trace-rows">
        {rows.map((row) => (
          <li key={row.key} className="trace-row">
            <div className="trace-row-head">
              <strong>{row.agentLabel}</strong>
              <span className={`trace-status trace-status-${row.status}`}>{row.statusLabel}</span>
              <span className="trace-elapsed">{row.elapsedMs} ms</span>
            </div>
            <p><span className="trace-key">Input</span> {row.inputSummary}</p>
            <p><span className="trace-key">Output</span> {row.outputSummary}</p>
            <p className="trace-route"><span className="trace-key">Route reason</span> {row.routeReason}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
