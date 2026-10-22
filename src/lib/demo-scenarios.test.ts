import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DemoScenarioSchema,
  FinalResponseSchema,
  type DemoScenario,
  type FinalResponse,
  type ResearchRequest,
} from "@/lib/contracts";
import {
  buildRoutePath,
  SCENARIO_SYMBOL,
  SCENARIO_SYMBOL_NOTE,
  DEMO_SCENARIO_OPTIONS,
  buildTraceRows,
  dataModeBadgeText,
  effectiveSymbol,
  scenarioChoiceFromText,
  scenarioToSend,
} from "@/components/trace-view-model";
import { runDemoScenario } from "@/lib/demo-scenarios";
import type { OkaneGraphOptions } from "@/lib/graph/okane-graph";

// node:test, no network. Every scenario uses a saved fixture and the real graph.

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

function deterministic(): OkaneGraphOptions {
  let now = 0;
  return {
    timer: () => {
      now += 10;
      return now;
    },
    clock: () => new Date("2026-10-08T10:00:00.000Z"),
    newRunId: () => "run_test_demo",
  };
}

async function runScenario(scenario: DemoScenario): Promise<FinalResponse> {
  const result = await runDemoScenario(scenario, request, deterministic());
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.response;
}

describe("demo scenarios", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "true";
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
  });

  it("1a. a normal run gives the straight route path", async () => {
    const response = await runScenario("normal");
    assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
    assert.deepEqual(buildRoutePath(response.trace, response.status), [
      "Research",
      "Strategist",
      "Risk",
      "Evaluator",
      "Human approval",
    ]);
  });

  it("1b. a risk revision run shows the Strategist twice with a revision marker", async () => {
    const response = await runScenario("risk_revision");
    assert.deepEqual(buildRoutePath(response.trace, response.status), [
      "Research",
      "Strategist",
      "Risk",
      "Strategist (revision 1)",
      "Risk",
      "Evaluator",
      "Human approval",
    ]);
  });

  it("1c. an insufficient data run shows only Research", async () => {
    const response = await runScenario("insufficient_data");
    assert.equal(response.status, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(buildRoutePath(response.trace, response.status), ["Research"]);
  });

  it("2. the risk revision scenario scripts only a weak first proposal; the real Risk Guardrail revises, then approves", async () => {
    const response = await runScenario("risk_revision");
    const riskEvents = response.trace.filter((event) => event.agent === "risk_guardrail");
    const strategistEvents = response.trace.filter((event) => event.agent === "strategist");
    assert.equal(response.trace.length, 6);
    assert.equal(strategistEvents.length, 2);
    assert.equal(riskEvents.length, 2);
    // Strategist: first weak, then the normal proposal, so the numbers differ.
    assert.match(strategistEvents[0].outputSummary, /BUY 1178 target 1206\.27 stop 1154\.44/);
    assert.match(strategistEvents[1].outputSummary, /BUY 1178 target 1225\.12 stop 1154\.44/);
    assert.notEqual(strategistEvents[0].outputSummary, strategistEvents[1].outputSummary);
    assert.match(strategistEvents[0].routeReason, /Scripted demo scenario: first proposal is deliberately weak/);
    assert.doesNotMatch(strategistEvents[1].routeReason, /Scripted/);
    // Risk is real: REVISE on the weak proposal, APPROVE on the revised one.
    assert.match(riskEvents[0].outputSummary, /^REVISE.*risk to reward 1\.2/);
    assert.match(riskEvents[1].outputSummary, /^APPROVE.*risk to reward 2$/);
    assert.doesNotMatch(riskEvents[0].routeReason, /Scripted/);
    assert.match(riskEvents[0].routeReason, /one bounded retry/);
    assert.equal(response.riskReview.decision, "APPROVE");
    assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
    assert.equal(FinalResponseSchema.safeParse(response).success, true);
  });

  it("3. every scenario gives the same result when run twice", async () => {
    for (const scenario of DemoScenarioSchema.options) {
      assert.deepEqual(await runScenario(scenario), await runScenario(scenario));
    }
  });

  it("5. every trace row has a non empty route reason, summaries and a status", async () => {
    for (const scenario of DemoScenarioSchema.options) {
      const response = await runScenario(scenario);
      const rows = buildTraceRows(response.trace);
      assert.equal(rows.length, response.trace.length);
      for (const row of rows) {
        assert.ok(row.routeReason.trim().length > 0);
        assert.ok(row.inputSummary.trim().length > 0);
        assert.ok(row.outputSummary.trim().length > 0);
        assert.ok(["ok", "error", "demo", "fallback"].includes(row.status));
      }
    }
  });

  it("5b. row status follows the error field and the data mode", async () => {
    const response = await runScenario("normal");
    const first = response.trace[0];
    const failed = { ...first, error: { code: "TIMEOUT", message: "Timed out" } };
    assert.equal(buildTraceRows([failed])[0].status, "error");
    assert.equal(buildTraceRows([{ ...first, error: null, dataMode: "provider" }])[0].status, "ok");
    // Deliberate demo data reads "demo data", not "fallback".
    assert.equal(buildTraceRows([first])[0].status, "demo");
    assert.equal(buildTraceRows([first])[0].statusLabel, "demo data");
    // A real provider failure replaced by a fixture keeps the fallback badge.
    const fellBack = {
      ...first,
      outputSummary: `${first.outputSummary}, fallback to labelled fixture after PROVIDER_ERROR`,
    };
    const rows = buildTraceRows([fellBack, response.trace[1]]);
    assert.equal(rows[0].status, "fallback");
    assert.equal(rows[1].status, "fallback");
    assert.equal(rows[0].statusLabel, "fallback");
  });

  it("6. the data mode badge text never says live or real time", () => {
    for (const mode of ["fixture", "provider"] as const) {
      const text = dataModeBadgeText(mode);
      assert.doesNotMatch(text, /\blive\b/i);
      assert.doesNotMatch(text, /real[\s-]?time/i);
    }
    assert.equal(dataModeBadgeText("fixture"), "Demo fixture data");
    assert.equal(dataModeBadgeText("provider"), "Provider data, delayed");
  });

  it("8. a scenario run for a different typed symbol is rejected, not silently swapped", async () => {
    for (const scenario of DemoScenarioSchema.options) {
      const result = await runDemoScenario(scenario, { ...request, symbol: "TCS.NS" }, deterministic());
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.error.code, "INVALID_REQUEST");
      assert.match(result.error.message, /RELIANCE\.NS/);
      assert.match(result.error.message, /without a scenario/);
    }
    // The fixture symbol itself, with or without the suffix and in any case, still runs.
    const bare = await runDemoScenario("normal", { ...request, symbol: "reliance" }, deterministic());
    assert.equal(bare.ok, true);
  });

  it("9. the form locks the symbol to the fixture symbol for a scenario and frees it for live data", () => {
    assert.equal(effectiveSymbol("normal", "TCS.NS"), SCENARIO_SYMBOL);
    assert.equal(effectiveSymbol("risk_revision", "TCS.NS"), SCENARIO_SYMBOL);
    assert.equal(effectiveSymbol("insufficient_data", "TCS.NS"), SCENARIO_SYMBOL);
    assert.equal(effectiveSymbol("live", "TCS.NS"), "TCS.NS");
    assert.equal(scenarioToSend("live"), undefined);
    assert.equal(scenarioToSend("normal"), "normal");
    assert.deepEqual(DEMO_SCENARIO_OPTIONS.map((option) => option.value), [
      "normal",
      "risk_revision",
      "insufficient_data",
      "live",
    ]);
    assert.equal(scenarioChoiceFromText("live"), "live");
    assert.equal(scenarioChoiceFromText("chaos"), undefined);
    assert.match(SCENARIO_SYMBOL_NOTE, /^Scenarios use saved RELIANCE\.NS data\. Choose Live data to try another symbol\.$/);
  });

  it("7. a scenario run is refused when demo mode is off", async () => {
    process.env[DEMO_VAR] = "false";
    const result = await runDemoScenario("risk_revision", request, deterministic());
    assert.equal(result.ok, false);
  });
});
