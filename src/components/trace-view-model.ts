import type {
  AgentName,
  DataMode,
  DemoScenario,
  RunStatus,
  TraceEvent,
} from "@/lib/contracts";

// Pure helpers behind the trace panel, the data mode badge and the scenario
// selector. No React and no server only imports, so tests can load them directly.

export const DEMO_SCENARIO_NOTICE = "Demo scenarios use saved fixture data, not live market data.";

export const DEMO_SCENARIO_OPTIONS: ReadonlyArray<{ value: DemoScenario; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "risk_revision", label: "Risk revision" },
  { value: "insufficient_data", label: "Insufficient data" },
];

export function dataModeBadgeText(dataMode: DataMode): string {
  return dataMode === "fixture" ? "Demo fixture data" : "Provider data, delayed";
}

const AGENT_LABELS: Record<AgentName, string> = {
  request_validator: "Request check",
  research: "Research",
  strategist: "Strategist",
  risk_guardrail: "Risk",
  evaluator: "Evaluator",
};

// Only these agents are sent back to by a bounded revision route. A second visit
// to the others is a re-check, so it keeps its plain name.
const REVISED_AGENTS: ReadonlySet<AgentName> = new Set(["research", "strategist"]);

export const HUMAN_APPROVAL_LABEL = "Human approval";

// Built from the trace events in order. The status only decides whether the
// human approval step is appended at the end.
export function buildRoutePath(events: readonly TraceEvent[], status?: RunStatus): string[] {
  const visits = new Map<AgentName, number>();
  const path = events.map((event) => {
    const count = (visits.get(event.agent) ?? 0) + 1;
    visits.set(event.agent, count);
    const label = AGENT_LABELS[event.agent];
    return count > 1 && REVISED_AGENTS.has(event.agent) ? `${label} (revision ${count - 1})` : label;
  });
  return status === "AWAITING_HUMAN_APPROVAL" ? [...path, HUMAN_APPROVAL_LABEL] : path;
}

// "demo" is saved data used on purpose. "fallback" is a real provider failure
// that was replaced by a labelled fixture.
export type TraceRowStatus = "ok" | "error" | "demo" | "fallback";

export type TraceRowView = {
  key: string;
  agentLabel: string;
  status: TraceRowStatus;
  statusLabel: string;
  elapsedMs: number;
  inputSummary: string;
  outputSummary: string;
  routeReason: string;
};

const FALLBACK_MARKER = /fallback to labelled fixture/i;

// True when any step of the run says a failed provider call was replaced by a fixture.
export function runUsedFallback(events: readonly TraceEvent[]): boolean {
  return events.some(
    (event) => FALLBACK_MARKER.test(event.outputSummary) || FALLBACK_MARKER.test(event.routeReason),
  );
}

export function rowStatus(event: TraceEvent, usedFallback = false): TraceRowStatus {
  if (event.error !== null) return "error";
  if (event.dataMode !== "fixture") return "ok";
  return usedFallback ? "fallback" : "demo";
}

export function rowStatusLabel(status: TraceRowStatus): string {
  return status === "demo" ? "demo data" : status;
}

export function buildTraceRows(events: readonly TraceEvent[]): TraceRowView[] {
  const labels = buildRoutePath(events);
  const usedFallback = runUsedFallback(events);
  return events.map((event, index) => ({
    key: `${index}-${event.agent}-${event.at}`,
    agentLabel: labels[index],
    status: rowStatus(event, usedFallback),
    statusLabel: rowStatusLabel(rowStatus(event, usedFallback)),
    elapsedMs: event.elapsedMs,
    inputSummary: event.inputSummary,
    outputSummary: event.outputSummary,
    routeReason: event.routeReason,
  }));
}

export function totalElapsedMs(events: readonly TraceEvent[]): number {
  return events.reduce((sum, event) => sum + event.elapsedMs, 0);
}
