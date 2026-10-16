import "server-only";

import { isDemoMode } from "@/lib/config";
import {
  MarketSnapshotSchema,
  type DemoScenario,
  type ResearchRequest,
} from "@/lib/contracts";
import marketInsufficient from "@/fixtures/market_insufficient_data.json";
import marketNormal from "@/fixtures/market_normal.json";
import { runResearchAgent } from "@/lib/agents/research";
import { runStrategistAgent } from "@/lib/agents/strategist";
import {
  runOkaneGraph,
  type GraphAgents,
  type OkaneGraphOptions,
  type OkaneGraphResult,
} from "@/lib/graph/okane-graph";
import { invokeModelSafely } from "@/lib/safe-model";

// Demo only scenarios for presentations. Every scenario runs the real graph, the
// real routing and the real agents. Market data always comes from a saved,
// labelled fixture, never from a provider. The browser sends only the scenario
// name; nothing in this file accepts prices or agent outputs from a caller.

function fixtureResearch(market: unknown): GraphAgents["research"] {
  const snapshot = MarketSnapshotSchema.parse(market);
  return (request, observeSnapshot) => {
    observeSnapshot(snapshot);
    return runResearchAgent(request, {
      getMarketSnapshot: async () => ({ ok: true, snapshot }),
      invokeModel: invokeModelSafely,
    });
  };
}

// The only scripted piece, and only for the risk revision scenario. The first
// Strategist call returns a deliberately weak proposal: the same direction,
// entry and stop as the real one, with a target pulled in so the real risk to
// reward is about 1.2. Nothing is scripted in Risk. The real Risk Guardrail
// returns REVISE, the Strategist runs again for real, and Risk approves the
// normal proposal. The label travels in the Strategist route reason.
const WEAK_RISK_REWARD = 1.2;
const WEAK_PROPOSAL_NOTE = "Scripted demo scenario: first proposal is deliberately weak";

function weakFirstStrategist(): GraphAgents["strategist"] {
  let calls = 0;
  return async (request, brief) => {
    calls += 1;
    const result = await runStrategistAgent(request, brief);
    if (calls > 1 || !result.ok || result.kind !== "PROPOSAL") return result;
    const { proposal } = result;
    const risk = Math.abs(proposal.entry - proposal.stop);
    const move = Math.round(risk * WEAK_RISK_REWARD * 100) / 100;
    const target = proposal.direction === "BUY" ? proposal.entry + move : proposal.entry - move;
    return {
      ...result,
      proposal: { ...proposal, target: Math.round(target * 100) / 100 },
      note: WEAK_PROPOSAL_NOTE,
    };
  };
}

function agentsFor(scenario: DemoScenario): Partial<GraphAgents> {
  switch (scenario) {
    case "normal":
      return { research: fixtureResearch(marketNormal) };
    case "insufficient_data":
      return { research: fixtureResearch(marketInsufficient) };
    case "risk_revision":
      return { research: fixtureResearch(marketNormal), strategist: weakFirstStrategist() };
  }
}

// The fixtures are saved for one symbol, so the scenario run is for that symbol.
function fixtureSymbol(scenario: DemoScenario): string {
  return MarketSnapshotSchema.parse(
    scenario === "insufficient_data" ? marketInsufficient : marketNormal,
  ).symbol;
}

// Never throws. Refuses to run unless the existing demo flag is on.
export async function runDemoScenario(
  scenario: DemoScenario,
  request: ResearchRequest,
  options: OkaneGraphOptions = {},
): Promise<OkaneGraphResult> {
  if (!isDemoMode()) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Demo scenarios are available only when demo mode is on",
        agent: "request_validator",
      },
    };
  }
  return runOkaneGraph(
    { ...request, symbol: fixtureSymbol(scenario) },
    { ...options, agents: { ...agentsFor(scenario), ...options.agents } },
  );
}
