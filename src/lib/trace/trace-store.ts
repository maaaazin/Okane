import "server-only";

import { TRACE_DEFAULTS } from "@/lib/config";
import type { TraceEvent } from "@/lib/contracts";
import { appendTraceEvent, createRunTrace, readTrace } from "@/lib/trace/run-trace";

// In memory store of the most recent runs, keyed by run id. It resets on server
// restart and on serverless cold starts, so it is demo evidence, not durable
// storage. It hangs off globalThis so the graph and the route handler share one
// store even if the bundler gives them separate module instances.

type Store = Map<string, readonly TraceEvent[]>;
type GlobalWithStore = typeof globalThis & { __okaneTraceStore?: Store };

function store(): Store {
  const holder = globalThis as GlobalWithStore;
  holder.__okaneTraceStore ??= new Map();
  return holder.__okaneTraceStore;
}

// Valid run id for lookups: letters, digits, underscore and dash only.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

// Never throws. Events that fail validation are skipped, the rest are stored.
export function saveRunTrace(runId: string, events: readonly unknown[]): void {
  try {
    const trace = createRunTrace(runId);
    for (const event of events) appendTraceEvent(trace, event);
    const runs = store();
    runs.delete(runId);
    runs.set(runId, readTrace(trace));
    while (runs.size > TRACE_DEFAULTS.maxRuns) {
      const oldest = runs.keys().next();
      if (oldest.done) break;
      runs.delete(oldest.value);
    }
  } catch {
    // Recording a trace must never break a run.
  }
}

export function getRunTrace(runId: string): readonly TraceEvent[] | undefined {
  return store().get(runId);
}

export function clearTraceStore(): void {
  store().clear();
}
