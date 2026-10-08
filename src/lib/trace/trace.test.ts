import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MarketSnapshotSchema,
  TraceEventSchema,
  type ResearchRequest,
  type TraceEvent,
} from "@/lib/contracts";
import { TRACE_DEFAULTS } from "@/lib/config";
import marketNormal from "@/fixtures/market_normal.json";
import marketInsufficient from "@/fixtures/market_insufficient_data.json";
import { runResearchAgent } from "@/lib/agents/research";
import { invokeModelSafely } from "@/lib/safe-model";
import { runOkaneGraph, type GraphAgents } from "@/lib/graph/okane-graph";
import { appendTraceEvent, createRunTrace, readTrace } from "@/lib/trace/run-trace";
import { clearTraceStore, getRunTrace, saveRunTrace } from "@/lib/trace/trace-store";
import { GET } from "@/app/api/trace/[runId]/route";

// node:test, no network. The market adapter is injected and the model is the
// deterministic mock in demo mode.

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

function researchWith(market: unknown): GraphAgents["research"] {
  const snapshot = MarketSnapshotSchema.parse(market);
  return (req, observeSnapshot) => {
    observeSnapshot(snapshot);
    return runResearchAgent(req, {
      getMarketSnapshot: async () => ({ ok: true, snapshot }),
      invokeModel: invokeModelSafely,
    });
  };
}

function options(runId: string) {
  let now = 0;
  return {
    timer: () => {
      now += 10;
      return now;
    },
    clock: () => new Date("2026-10-08T10:00:00.000Z"),
    newRunId: () => runId,
  };
}

function sampleEvent(runId: string, overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    runId,
    at: "2026-10-08T10:00:00.000Z",
    agent: "research",
    event: "completed",
    inputSummary: "RELIANCE.NS, 5 days, paper mode",
    outputSummary: "EVIDENCE_READY, 3 evidence items",
    routeReason: "Evidence is sufficient, hand off to the Strategist",
    elapsedMs: 12,
    dataMode: "fixture",
    error: null,
    ...overrides,
  };
}

async function routeGet(runId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/trace/${runId}`), {
    params: Promise.resolve({ runId }),
  });
}

describe("run trace", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "true";
    clearTraceStore();
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
    clearTraceStore();
  });

  it("a. events cannot be changed or removed after they are appended", () => {
    const trace = createRunTrace("run_a");
    const result = appendTraceEvent(trace, sampleEvent("run_a"));
    assert.deepEqual(result, { ok: true, count: 1 });

    const copy = readTrace(trace);
    assert.ok(Object.isFrozen(copy));
    assert.ok(Object.isFrozen(copy[0]));
    assert.throws(() => {
      (copy[0] as { agent: string }).agent = "evaluator";
    }, TypeError);
    assert.throws(() => (copy as TraceEvent[]).pop(), TypeError);
    assert.throws(() => (copy as TraceEvent[]).push(sampleEvent("run_a")), TypeError);

    // The caller's own object is copied on append, so editing it changes nothing.
    const original = sampleEvent("run_a");
    appendTraceEvent(trace, original);
    original.outputSummary = "edited after append";
    const again = readTrace(trace);
    assert.equal(again.length, 2);
    assert.equal(again[1].outputSummary, "EVIDENCE_READY, 3 evidence items");
    assert.deepEqual(again[0], sampleEvent("run_a"));
  });

  it("b. an invalid event is rejected with a StructuredError and append never throws", () => {
    const trace = createRunTrace("run_b");
    const bad: unknown[] = [
      null,
      undefined,
      "text",
      42,
      {},
      sampleEvent("run_b", { agent: "intruder" as TraceEvent["agent"] }),
      sampleEvent("run_b", { elapsedMs: -1 }),
      sampleEvent("run_b", { routeReason: "" }),
      sampleEvent("run_other"),
    ];
    for (const event of bad) {
      const result = appendTraceEvent(trace, event);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.ok(result.error.message.length > 0);
    }
    assert.equal(readTrace(trace).length, 0);

    const foreign = appendTraceEvent({ runId: "run_b" }, sampleEvent("run_b"));
    assert.equal(foreign.ok, false);
  });

  it("c. every event of a normal demo run carries the required fields and a marker", async () => {
    const result = await runOkaneGraph(request, {
      ...options("run_c"),
      agents: { research: researchWith(marketNormal) },
    });
    assert.equal(result.ok, true);
    const events = getRunTrace("run_c");
    assert.ok(events !== undefined);
    assert.deepEqual(
      events.map((event) => event.agent),
      ["research", "strategist", "risk_guardrail", "evaluator"],
    );
    for (const event of events) {
      assert.equal(TraceEventSchema.safeParse(event).success, true);
      assert.equal(event.runId, "run_c");
      assert.ok(event.at.length > 0);
      assert.ok(event.inputSummary.length > 0);
      assert.ok(event.outputSummary.length > 0);
      assert.ok(Number.isInteger(event.elapsedMs));
      assert.ok(event.routeReason.length > 0);
      // Marker fields: dataMode marks fixture fallback, error marks failure.
      assert.equal(event.dataMode, "fixture");
      assert.ok("error" in event);
      assert.equal(event.error, null);
    }
  });

  it("d. a NO_TRADE run and an ERROR run are both stored", async () => {
    const noTrade = await runOkaneGraph(request, {
      ...options("run_d_no_trade"),
      agents: { research: researchWith(marketInsufficient) },
    });
    assert.equal(noTrade.ok, true);
    assert.equal(noTrade.ok && noTrade.response.status, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(getRunTrace("run_d_no_trade")?.map((event) => event.agent), ["research"]);

    const rejected = await runOkaneGraph(request, {
      ...options("run_d_reject"),
      agents: {
        research: researchWith(marketNormal),
        risk: () => ({
          decision: "REJECT",
          positionSizeShares: 0,
          maxLossInr: 0,
          riskRewardRatio: null,
          reasons: ["Stop distance exceeds the risk budget"],
        }),
      },
    });
    assert.equal(rejected.ok && rejected.response.status, "NO_TRADE");
    assert.ok(getRunTrace("run_d_reject") !== undefined);

    const errored = await runOkaneGraph(request, {
      ...options("run_d_error"),
      agents: {
        research: researchWith(marketNormal),
        strategist: async () => {
          throw new Error("boom");
        },
      },
    });
    assert.equal(errored.ok, false);
    const events = getRunTrace("run_d_error");
    assert.ok(events !== undefined);
    const last = events.at(-1);
    assert.equal(last?.agent, "strategist");
    assert.equal(last?.event, "failed");
    assert.equal(last?.error?.code, "UNKNOWN");
    assert.ok(!JSON.stringify(events).includes("boom"));
  });

  it("e. the store keeps only the most recent runs, oldest dropped first", () => {
    const total = TRACE_DEFAULTS.maxRuns + 3;
    for (let index = 0; index < total; index += 1) {
      const runId = `run_e_${index}`;
      saveRunTrace(runId, [sampleEvent(runId)]);
    }
    for (let index = 0; index < 3; index += 1) {
      assert.equal(getRunTrace(`run_e_${index}`), undefined);
    }
    for (let index = 3; index < total; index += 1) {
      assert.equal(getRunTrace(`run_e_${index}`)?.length, 1);
    }
    clearTraceStore();
    assert.equal(getRunTrace(`run_e_${total - 1}`), undefined);
  });

  it("f. the route returns an attachment for a stored run and 404 otherwise", async () => {
    saveRunTrace("run_f", [sampleEvent("run_f")]);

    const found = await routeGet("run_f");
    assert.equal(found.status, 200);
    assert.equal(found.headers.get("content-disposition"), 'attachment; filename="trace_run_f.json"');
    assert.match(found.headers.get("content-type") ?? "", /^application\/json/);
    const body: unknown = await found.json();
    assert.deepEqual(body, [sampleEvent("run_f")]);

    const unknown = await routeGet("run_missing");
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "Trace not found" });

    for (const malformed of ["../secrets", "run f", "a/b", "x".repeat(65), "run%00", ""]) {
      const response = await routeGet(malformed);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("content-disposition"), null);
    }
  });

  it("g. the sample traces validate against TraceEventSchema", () => {
    for (const file of ["sample_trace.json", "sample_trace_insufficient_data.json"]) {
      const parsed: unknown = JSON.parse(readFileSync(join("docs", "evidence", file), "utf8"));
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.length >= 1);
      for (const event of parsed) {
        assert.equal(TraceEventSchema.safeParse(event).success, true);
      }
    }
  });
});
