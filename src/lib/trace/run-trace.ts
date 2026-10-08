import "server-only";

import {
  TraceEventSchema,
  type StructuredError,
  type TraceEvent,
} from "@/lib/contracts";

// Trace helpers. Building an event validates it with TraceEventSchema, and a run
// trace is append only: events are validated, copied and frozen on the way in,
// and a read always returns a fresh frozen copy.

// Validates and returns one trace event. Throws a ZodError for a bad event, so
// the graph node wrapper turns a bad event into its existing failed step path.
export function buildTraceEvent(input: unknown): TraceEvent {
  return TraceEventSchema.parse(input);
}

export type RunTrace = { readonly runId: string };

export type AppendResult =
  | { ok: true; count: number }
  | { ok: false; error: StructuredError };

const eventsByTrace = new WeakMap<RunTrace, TraceEvent[]>();

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function createRunTrace(runId: string): RunTrace {
  const trace: RunTrace = Object.freeze({ runId });
  eventsByTrace.set(trace, []);
  return trace;
}

// Never throws. A bad event is not recorded and comes back as a StructuredError.
export function appendTraceEvent(trace: RunTrace, event: unknown): AppendResult {
  try {
    const events = eventsByTrace.get(trace);
    if (events === undefined) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Unknown run trace" } };
    }
    const parsed = TraceEventSchema.safeParse(event);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "event"))];
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: `Trace event did not match the expected shape: ${fields.join(", ")}`,
        },
      };
    }
    if (parsed.data.runId !== trace.runId) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Trace event run id does not match the trace" },
      };
    }
    events.push(deepFreeze(structuredClone(parsed.data)));
    return { ok: true, count: events.length };
  } catch {
    return { ok: false, error: { code: "UNKNOWN", message: "Unexpected failure while appending a trace event" } };
  }
}

// A frozen copy. Changing it cannot change the trace.
export function readTrace(trace: RunTrace): readonly TraceEvent[] {
  const events = eventsByTrace.get(trace) ?? [];
  return deepFreeze(structuredClone(events));
}
