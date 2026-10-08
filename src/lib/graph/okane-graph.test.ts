import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  FinalResponseSchema,
  MarketSnapshotSchema,
  type EvaluatorInput,
  type FinalResponse,
  type NextRoute,
  type ResearchRequest,
  type RiskDecision,
  type RiskReview,
} from "@/lib/contracts";
import marketNormal from "@/fixtures/market_normal.json";
import marketInsufficient from "@/fixtures/market_insufficient_data.json";
import { runEvaluatorAgent } from "@/lib/agents/evaluator";
import { runResearchAgent } from "@/lib/agents/research";
import { runRiskGuardrail } from "@/lib/agents/risk";
import { runStrategistAgent } from "@/lib/agents/strategist";
import { clearMarketDataCache, type MarketDataResult } from "@/lib/data/market-data";
import { invokeModelSafely } from "@/lib/safe-model";
import {
  runOkaneGraph,
  type GraphAgents,
  type OkaneGraphOptions,
  type OkaneGraphResult,
} from "@/lib/graph/okane-graph";

// node:test, same style as the other tests. The market adapter is injected, so
// no test touches the network. The model is the deterministic mock in demo mode.

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

const normalMarket: MarketDataResult = {
  ok: true,
  snapshot: MarketSnapshotSchema.parse(marketNormal),
};
const insufficientMarket: MarketDataResult = {
  ok: true,
  snapshot: MarketSnapshotSchema.parse(marketInsufficient),
};

function researchWith(market: MarketDataResult): GraphAgents["research"] {
  return (req, observeSnapshot) => {
    if (market.ok) observeSnapshot(market.snapshot);
    return runResearchAgent(req, {
      getMarketSnapshot: async () => market,
      invokeModel: invokeModelSafely,
    });
  };
}

function counted<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  let calls = 0;
  return {
    fn: (...args: Args): Result => {
      calls += 1;
      return fn(...args);
    },
    calls: () => calls,
  };
}

function reviewFor(decision: RiskDecision): RiskReview {
  if (decision === "APPROVE") {
    return {
      decision,
      positionSizeShares: 100,
      maxLossInr: 5000,
      riskRewardRatio: 2,
      reasons: ["Stop distance and risk to reward are within limits"],
    };
  }
  return {
    decision,
    positionSizeShares: 0,
    maxLossInr: 0,
    riskRewardRatio: decision === "REVISE" ? 1.2 : null,
    reasons: [
      decision === "REVISE"
        ? "Risk to reward is 1.20, below the 1.5 minimum"
        : "Stop distance exceeds the risk budget",
    ],
  };
}

// Returns the listed decisions in order, then repeats the last one.
function riskSequence(decisions: RiskDecision[]) {
  let index = 0;
  return counted((): RiskReview => {
    const decision = decisions[Math.min(index, decisions.length - 1)];
    index += 1;
    return reviewFor(decision);
  });
}

// Real evaluator, with its route replaced by the listed routes in order.
function evaluatorRoutes(routes: NextRoute[]) {
  let index = 0;
  return counted((input: EvaluatorInput) => {
    const result = runEvaluatorAgent(input);
    const route = routes[Math.min(index, routes.length - 1)];
    index += 1;
    return result.ok ? { ok: true as const, evaluation: { ...result.evaluation, nextRoute: route } } : result;
  });
}

function deterministic(): OkaneGraphOptions {
  let now = 0;
  return {
    timer: () => {
      now += 10;
      return now;
    },
    clock: () => new Date("2026-10-08T10:00:00.000Z"),
    newRunId: () => "run_test_001",
  };
}

function demoAgents(overrides: Partial<GraphAgents> = {}): Partial<GraphAgents> {
  return { research: researchWith(normalMarket), ...overrides };
}

function expectResponse(result: OkaneGraphResult): FinalResponse {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.response;
}

function agentsOf(response: FinalResponse): string[] {
  return response.trace.map((event) => event.agent);
}

describe("runOkaneGraph", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "true";
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
  });

  it("1. a normal demo run ends awaiting human approval with a full trace", async () => {
    const response = expectResponse(
      await runOkaneGraph(request, { ...deterministic(), agents: demoAgents() }),
    );
    assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
    assert.equal(response.approvalStatus, "PENDING_HUMAN");
    assert.deepEqual(agentsOf(response), ["research", "strategist", "risk_guardrail", "evaluator"]);
    assert.ok(response.tradeProposal);
    assert.equal(response.riskReview.decision, "APPROVE");
    assert.equal(response.evaluation.nextRoute, "HUMAN_APPROVAL");
    assert.equal(response.dataMode, "fixture");
    assert.ok(response.demoLabel);
    assert.ok(response.trace.every((event) => event.dataMode === "fixture"));
    assert.ok(response.trace.every((event) => event.elapsedMs === 10));
    assert.equal(response.requestId, "run_test_001");
  });

  it("2. insufficient research ends with no further agent and only the Research trace event", async () => {
    const strategist = counted(runStrategistAgent);
    const risk = counted(runRiskGuardrail);
    const evaluator = counted(runEvaluatorAgent);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: {
          research: researchWith(insufficientMarket),
          strategist: strategist.fn,
          risk: risk.fn,
          evaluator: evaluator.fn,
        },
      }),
    );
    assert.equal(response.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(response.approvalStatus, "NOT_APPLICABLE");
    assert.deepEqual(agentsOf(response), ["research"]);
    assert.equal(response.tradeProposal, undefined);
    assert.equal(strategist.calls() + risk.calls() + evaluator.calls(), 0);
  });

  it("2b. a Research agent error ends with no trade and only the Research trace event", async () => {
    const strategist = counted(runStrategistAgent);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: {
          research: async () => ({
            ok: false,
            error: { code: "TIMEOUT", message: "Model call timed out", agent: "research" },
            modelSource: "none",
          }),
          strategist: strategist.fn,
        },
      }),
    );
    assert.equal(response.status, "NO_TRADE");
    assert.deepEqual(agentsOf(response), ["research"]);
    assert.equal(response.trace[0].event, "failed");
    assert.equal(response.errors[0].code, "TIMEOUT");
    assert.equal(strategist.calls(), 0);
  });

  it("3. a Risk REJECT ends with no trade and no approval", async () => {
    const risk = riskSequence(["REJECT"]);
    const evaluator = counted(runEvaluatorAgent);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: demoAgents({ risk: risk.fn, evaluator: evaluator.fn }),
      }),
    );
    assert.equal(response.status, "NO_TRADE");
    assert.equal(response.approvalStatus, "NOT_APPLICABLE");
    assert.equal(response.riskReview.decision, "REJECT");
    assert.equal(response.tradeProposal, undefined);
    // ARCHITECTURE.md routes REJECT straight to NO_TRADE.
    assert.deepEqual(agentsOf(response), ["research", "strategist", "risk_guardrail"]);
    assert.equal(evaluator.calls(), 0);
  });

  it("4. a Risk REVISE goes back to the Strategist exactly once, with the constraints, then continues", async () => {
    const theses: Array<string | undefined> = [];
    const strategist = counted((req: ResearchRequest, brief: Parameters<GraphAgents["strategist"]>[1]) => {
      theses.push(req.thesis);
      return runStrategistAgent(req, brief);
    });
    const risk = riskSequence(["REVISE", "APPROVE"]);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: demoAgents({ strategist: strategist.fn, risk: risk.fn }),
      }),
    );
    assert.equal(strategist.calls(), 2);
    assert.equal(risk.calls(), 2);
    assert.equal(theses[0], undefined);
    assert.match(theses[1] ?? "", /Revision constraints: .*below the 1.5 minimum/);
    assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
    assert.deepEqual(agentsOf(response), [
      "research",
      "strategist",
      "risk_guardrail",
      "strategist",
      "risk_guardrail",
      "evaluator",
    ]);
    assert.match(response.trace[2].routeReason, /one bounded retry/);
  });

  it("5. a second REVISE does not loop again and ends with no trade", async () => {
    const strategist = counted(runStrategistAgent);
    const risk = riskSequence(["REVISE"]);
    const evaluator = counted(runEvaluatorAgent);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: demoAgents({ strategist: strategist.fn, risk: risk.fn, evaluator: evaluator.fn }),
      }),
    );
    assert.equal(response.status, "NO_TRADE");
    assert.equal(strategist.calls(), 2);
    assert.equal(risk.calls(), 2);
    assert.equal(evaluator.calls(), 0);
    assert.match(response.trace.at(-1)?.routeReason ?? "", /revision limit is reached/);
  });

  it("6a. an Evaluator route back to the Strategist happens at most once", async () => {
    const strategist = counted(runStrategistAgent);
    const evaluator = evaluatorRoutes(["STRATEGIST"]);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: demoAgents({ strategist: strategist.fn, evaluator: evaluator.fn }),
      }),
    );
    assert.equal(strategist.calls(), 2);
    assert.equal(evaluator.calls(), 2);
    assert.equal(response.status, "NO_TRADE");
    assert.equal(response.approvalStatus, "NOT_APPLICABLE");
  });

  it("6b. an Evaluator route back to Research happens at most once", async () => {
    const research = counted(researchWith(normalMarket));
    const evaluator = evaluatorRoutes(["RESEARCH"]);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: { research: research.fn, evaluator: evaluator.fn },
      }),
    );
    assert.equal(research.calls(), 2);
    assert.equal(evaluator.calls(), 2);
    assert.equal(response.status, "NO_TRADE");
  });

  it("6c. one Evaluator revision followed by permission still reaches human approval", async () => {
    const evaluator = evaluatorRoutes(["STRATEGIST", "HUMAN_APPROVAL"]);
    const response = expectResponse(
      await runOkaneGraph(request, {
        ...deterministic(),
        agents: demoAgents({ evaluator: evaluator.fn }),
      }),
    );
    assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
    assert.equal(evaluator.calls(), 2);
  });

  it("7. every trace event has a non empty routeReason", async () => {
    const scenarios: Array<Partial<GraphAgents>> = [
      demoAgents(),
      demoAgents({ risk: riskSequence(["REVISE", "APPROVE"]).fn }),
      demoAgents({ risk: riskSequence(["REJECT"]).fn }),
      demoAgents({ evaluator: evaluatorRoutes(["RESEARCH"]).fn }),
      { research: researchWith(insufficientMarket) },
    ];
    for (const agents of scenarios) {
      const response = expectResponse(await runOkaneGraph(request, { ...deterministic(), agents }));
      assert.ok(response.trace.length >= 1);
      for (const event of response.trace) {
        assert.ok(event.routeReason.trim().length > 0);
      }
    }
  });

  it("8. a node that throws becomes a structured error and the graph does not throw", async () => {
    const throwing: Array<[string, Partial<GraphAgents>]> = [
      ["research", { research: async () => { throw new Error("boom"); } }],
      ["strategist", demoAgents({ strategist: async () => { throw new Error("boom"); } })],
      ["risk_guardrail", demoAgents({ risk: () => { throw new Error("boom"); } })],
      ["evaluator", demoAgents({ evaluator: () => { throw new Error("boom"); } })],
    ];
    for (const [agent, agents] of throwing) {
      const result = await runOkaneGraph(request, { ...deterministic(), agents });
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.error.code, "UNKNOWN");
      assert.equal(result.error.agent, agent);
      assert.ok(!result.error.message.includes("boom"));
    }
  });

  it("8b. an invalid request returns a structured error before any agent runs", async () => {
    const research = counted(researchWith(normalMarket));
    const result = await runOkaneGraph(
      { ...request, horizonDays: 99 },
      { ...deterministic(), agents: { research: research.fn } },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INVALID_REQUEST");
    assert.equal(research.calls(), 0);
  });

  it("9. every successful output validates with FinalResponseSchema", async () => {
    const scenarios: Array<Partial<GraphAgents>> = [
      demoAgents(),
      demoAgents({ risk: riskSequence(["REJECT"]).fn }),
      demoAgents({ risk: riskSequence(["REVISE"]).fn }),
      demoAgents({ evaluator: evaluatorRoutes(["STRATEGIST"]).fn }),
      { research: researchWith(insufficientMarket) },
    ];
    for (const agents of scenarios) {
      const response = expectResponse(await runOkaneGraph(request, { ...deterministic(), agents }));
      assert.equal(FinalResponseSchema.safeParse(response).success, true);
    }
  });

  it("10. the same input gives the same output in demo mode", async () => {
    const first = await runOkaneGraph(request, { ...deterministic(), agents: demoAgents() });
    const second = await runOkaneGraph(request, { ...deterministic(), agents: demoAgents() });
    assert.deepEqual(first, second);
  });

  it("11. the default agents work in demo mode with no network and no API key", async () => {
    const savedFetch = globalThis.fetch;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = async () => {
      throw new TypeError("network disabled for this test");
    };
    clearMarketDataCache();
    try {
      const response = expectResponse(await runOkaneGraph(request, deterministic()));
      assert.equal(response.status, "AWAITING_HUMAN_APPROVAL");
      assert.equal(response.dataMode, "fixture");
      assert.ok(response.demoLabel);
      assert.match(response.trace[0].outputSummary, /fallback to labelled fixture/);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      clearMarketDataCache();
    }
  });
});
