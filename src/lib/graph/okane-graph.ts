import "server-only";

import { randomUUID } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import { GRAPH_DEFAULTS } from "@/lib/config";
import {
  EvaluatorInputSchema,
  ResearchRequestSchema,
  RiskReviewSchema,
  TraceEventSchema,
  type AgentName,
  type DataMode,
  type EvaluatorInput,
  type FinalResponse,
  type MarketSnapshot,
  type ResearchBrief,
  type ResearchRequest,
  type RiskReview,
  type StructuredError,
  type TraceEvent,
  type TradeProposal,
} from "@/lib/contracts";
import { runEvaluatorAgent } from "@/lib/agents/evaluator";
import { runResearchAgent, type ResearchAgentResult } from "@/lib/agents/research";
import { runRiskGuardrail } from "@/lib/agents/risk";
import { runStrategistAgent, type StrategistAgentResult } from "@/lib/agents/strategist";
import { getMarketSnapshot } from "@/lib/data/market-data";
import { invokeModelSafely } from "@/lib/safe-model";
import { buildFinalResponse } from "@/lib/graph/final-response";
import {
  routeAfterEvaluation,
  routeAfterResearch,
  routeAfterRisk,
  routeAfterStrategist,
  type RouteDecision,
} from "@/lib/graph/routing";
import { OkaneGraphState, type OkaneGraphStateType, type OkaneGraphUpdate } from "@/lib/graph/state";

// The Okane LangGraph. Nodes call the existing agents and write the route
// decision to shared state. The conditional edges only read that decision, so
// the trace and the actual route always agree.

export type EvaluatorAgentResult = ReturnType<typeof runEvaluatorAgent>;

export type GraphAgents = {
  // The second argument reports the market snapshot the agent used, when it has one.
  research: (
    request: ResearchRequest,
    observeSnapshot: (snapshot: MarketSnapshot) => void,
  ) => Promise<ResearchAgentResult>;
  strategist: (request: ResearchRequest, brief: ResearchBrief) => Promise<StrategistAgentResult>;
  risk: (proposal: TradeProposal, portfolioValueInr: number) => RiskReview | Promise<RiskReview>;
  evaluator: (input: EvaluatorInput) => EvaluatorAgentResult;
};

export type OkaneGraphOptions = {
  agents?: Partial<GraphAgents>;
  // Milliseconds from any monotonic origin. Injected so tests are deterministic.
  timer?: () => number;
  // Wall clock for trace timestamps.
  clock?: () => Date;
  // Request identifier source.
  newRunId?: () => string;
};

export type OkaneGraphResult =
  | { ok: true; response: FinalResponse }
  | { ok: false; error: StructuredError };

const defaultAgents: GraphAgents = {
  research: (request, observeSnapshot) =>
    runResearchAgent(request, {
      getMarketSnapshot: async (symbol) => {
        const result = await getMarketSnapshot(symbol);
        if (result.ok) observeSnapshot(result.snapshot);
        return result;
      },
      invokeModel: invokeModelSafely,
    }),
  strategist: (request, brief) => runStrategistAgent(request, brief),
  risk: (proposal, portfolioValueInr) => runRiskGuardrail(proposal, portfolioValueInr),
  evaluator: (input) => runEvaluatorAgent(input),
};

type Runtime = {
  agents: GraphAgents;
  timer: () => number;
  clock: () => Date;
};

type NodeOutcome = {
  update: OkaneGraphUpdate;
  decision: RouteDecision;
  inputSummary: string;
  outputSummary: string;
  event: TraceEvent["event"];
  error: StructuredError | null;
  dataMode: DataMode;
};

function unexpectedError(agent: AgentName): StructuredError {
  return { code: "UNKNOWN", message: `Unexpected failure in the ${agent} step`, agent };
}

function stateDataMode(state: OkaneGraphStateType): DataMode {
  return state.researchBrief?.dataMode ?? state.marketSnapshot?.dataMode ?? "provider";
}

// Runs a node body, times it, and appends exactly one trace event. A body that
// throws becomes a failed trace event and an ERROR status, never an exception.
function makeNode(
  agent: AgentName,
  runtime: Runtime,
  body: (state: OkaneGraphStateType) => Promise<NodeOutcome>,
) {
  return async (state: OkaneGraphStateType): Promise<OkaneGraphUpdate> => {
    const startedAt = runtime.timer();
    const elapsed = () => Math.max(0, Math.round(runtime.timer() - startedAt));
    try {
      const outcome = await body(state);
      const event = TraceEventSchema.parse({
        runId: state.requestId,
        at: runtime.clock().toISOString(),
        agent,
        event: outcome.event,
        inputSummary: outcome.inputSummary,
        outputSummary: outcome.outputSummary,
        routeReason: outcome.decision.reason,
        elapsedMs: elapsed(),
        dataMode: outcome.dataMode,
        error: outcome.error,
      });
      return {
        ...outcome.update,
        status: outcome.decision.status,
        nextStep: outcome.decision.next,
        routeReason: outcome.decision.reason,
        trace: [event],
      };
    } catch {
      const error = unexpectedError(agent);
      const reason = `The ${agent} step failed unexpectedly, the run closes with a structured error`;
      const event = TraceEventSchema.parse({
        runId: state.requestId,
        at: runtime.clock().toISOString(),
        agent,
        event: "failed",
        inputSummary: `Input for the ${agent} step`,
        outputSummary: "The step threw an unexpected error",
        routeReason: reason,
        elapsedMs: elapsed(),
        dataMode: stateDataMode(state),
        error,
      });
      return {
        status: "ERROR",
        nextStep: "end",
        routeReason: reason,
        errors: [error],
        trace: [event],
      };
    }
  };
}

function describeProposal(proposal: TradeProposal): string {
  return `${proposal.direction} ${proposal.entry} target ${proposal.target} stop ${proposal.stop}`;
}

function describeRequest(request: ResearchRequest): string {
  return `${request.symbol}, ${request.horizonDays} days, paper mode`;
}

// Feedback for a Strategist retry. The Strategist takes no constraints argument,
// so the constraints travel in the thesis text that its prompt already includes.
function revisionConstraints(state: OkaneGraphStateType): string | undefined {
  if (state.strategyRevisionCount === 0) return undefined;
  if (state.riskReview?.decision === "REVISE") return state.riskReview.reasons.join("; ");
  if (state.evaluation !== null) {
    return `${state.evaluation.notes} Flags: ${state.evaluation.flags.join(", ") || "none"}`;
  }
  return undefined;
}

function buildNodes(runtime: Runtime) {
  const { agents } = runtime;

  const research = makeNode("research", runtime, async (state) => {
    const observed: { snapshot?: MarketSnapshot } = {};
    const result = await agents.research(state.request, (snapshot) => {
      observed.snapshot = snapshot;
    });
    const snapshot = observed.snapshot ?? null;
    const cleared = { tradeProposal: null, riskReview: null, evaluation: null } as const;
    const inputSummary = describeRequest(state.request);

    if (!result.ok) {
      return {
        update: { ...cleared, marketSnapshot: snapshot, researchBrief: null, evidence: [], errors: [result.error] },
        decision: {
          next: "end",
          status: "NO_TRADE",
          reason: `Research failed (${result.error.code}), run closes without a trade`,
        },
        inputSummary,
        outputSummary: `Research error ${result.error.code}: ${result.error.message}`,
        event: "failed",
        error: result.error,
        dataMode: snapshot?.dataMode ?? "provider",
      };
    }

    const { brief } = result;
    const decision = routeAfterResearch(brief);
    const fallback =
      result.fallbackReason === undefined
        ? ""
        : `, fallback to labelled fixture after ${result.fallbackReason.code}`;
    return {
      update: {
        ...cleared,
        marketSnapshot: snapshot,
        researchBrief: brief,
        evidence: brief.evidence,
        errors: result.marketError === undefined ? [] : [result.marketError],
      },
      decision,
      inputSummary,
      outputSummary: `${brief.status}, ${brief.evidence.length} evidence items, quality ${brief.dataQuality}, model ${brief.modelSource}${fallback}`,
      event: "completed",
      error: result.marketError ?? null,
      dataMode: brief.dataMode ?? snapshot?.dataMode ?? "provider",
    };
  });

  const strategist = makeNode("strategist", runtime, async (state) => {
    const brief = state.researchBrief;
    if (brief === null) throw new Error("Strategist reached without a research brief");
    const constraints = revisionConstraints(state);
    const request: ResearchRequest =
      constraints === undefined
        ? state.request
        : {
            ...state.request,
            thesis: `${state.request.thesis === undefined ? "" : `${state.request.thesis} `}Revision constraints: ${constraints}`,
          };
    const result = await agents.strategist(request, brief);
    const decision = routeAfterStrategist(result);
    const cleared = { riskReview: null, evaluation: null } as const;
    const inputSummary = `${brief.evidence.length} evidence items${constraints === undefined ? "" : " and revision constraints"}`;
    const dataMode = stateDataMode(state);

    if (!result.ok) {
      return {
        update: { ...cleared, tradeProposal: null, errors: [result.error] },
        decision,
        inputSummary,
        outputSummary: `Strategist error ${result.error.code}: ${result.error.message}`,
        event: "failed",
        error: result.error,
        dataMode,
      };
    }
    if (result.kind === "NO_TRADE") {
      return {
        update: { ...cleared, tradeProposal: null },
        decision,
        inputSummary,
        outputSummary: `${result.decision}: ${result.reason}`,
        event: "completed",
        error: null,
        dataMode,
      };
    }
    return {
      update: { ...cleared, tradeProposal: result.proposal },
      decision,
      inputSummary,
      outputSummary: describeProposal(result.proposal),
      event: "completed",
      error: null,
      dataMode,
    };
  });

  const risk = makeNode("risk_guardrail", runtime, async (state) => {
    const proposal = state.tradeProposal;
    if (proposal === null) throw new Error("Risk Guardrail reached without a proposal");
    const review = RiskReviewSchema.parse(
      await agents.risk(proposal, state.request.portfolioValueInr),
    );
    const decision = routeAfterRisk(review, state.strategyRevisionCount);
    return {
      update: {
        riskReview: review,
        evaluation: null,
        strategyRevisionCount:
          decision.spends === "strategy"
            ? state.strategyRevisionCount + 1
            : state.strategyRevisionCount,
      },
      decision,
      inputSummary: `${proposal.direction} proposal for ${proposal.symbol}`,
      outputSummary: `${review.decision}: ${review.positionSizeShares} shares, risk to reward ${review.riskRewardRatio ?? "not available"}`,
      event: "completed",
      error: null,
      dataMode: stateDataMode(state),
    };
  });

  const evaluator = makeNode("evaluator", runtime, async (state) => {
    const brief = state.researchBrief;
    if (brief === null) throw new Error("Evaluator reached without a research brief");
    const input = EvaluatorInputSchema.parse({
      brief,
      proposal: state.tradeProposal,
      riskReview: state.riskReview,
      timings: state.trace.map((event) => ({ agent: event.agent, elapsedMs: event.elapsedMs })),
      counters: {
        researchRevisionCount: state.researchRevisionCount,
        strategyRevisionCount: state.strategyRevisionCount,
      },
    });
    const result = agents.evaluator(input);
    const inputSummary = "Proposal, risk review and evidence";
    const dataMode = stateDataMode(state);

    if (!result.ok) {
      return {
        update: { evaluation: null, errors: [result.error] },
        decision: {
          next: "end",
          status: "NO_TRADE",
          reason: `Evaluator failed (${result.error.code}), run closes without a trade`,
        },
        inputSummary,
        outputSummary: `Evaluator error ${result.error.code}: ${result.error.message}`,
        event: "failed",
        error: result.error,
        dataMode,
      };
    }

    const { evaluation } = result;
    const decision = routeAfterEvaluation(evaluation, {
      proposal: state.tradeProposal,
      riskReview: state.riskReview,
      researchRevisionCount: state.researchRevisionCount,
      strategyRevisionCount: state.strategyRevisionCount,
    });
    return {
      update: {
        evaluation,
        researchRevisionCount:
          decision.spends === "research"
            ? state.researchRevisionCount + 1
            : state.researchRevisionCount,
        strategyRevisionCount:
          decision.spends === "strategy"
            ? state.strategyRevisionCount + 1
            : state.strategyRevisionCount,
      },
      decision,
      inputSummary,
      outputSummary: `Score ${evaluation.score}, route ${evaluation.nextRoute}`,
      event: "routed",
      error: null,
      dataMode,
    };
  });

  return { research, strategist, risk, evaluator };
}

function buildGraph(runtime: Runtime) {
  const nodes = buildNodes(runtime);
  return new StateGraph(OkaneGraphState)
    .addNode("research", nodes.research)
    .addNode("strategist", nodes.strategist)
    .addNode("risk_guardrail", nodes.risk)
    .addNode("evaluator", nodes.evaluator)
    .addEdge(START, "research")
    .addConditionalEdges("research", (state) => state.nextStep, {
      strategist: "strategist",
      end: END,
    })
    .addConditionalEdges("strategist", (state) => state.nextStep, {
      risk_guardrail: "risk_guardrail",
      end: END,
    })
    .addConditionalEdges("risk_guardrail", (state) => state.nextStep, {
      strategist: "strategist",
      evaluator: "evaluator",
      end: END,
    })
    .addConditionalEdges("evaluator", (state) => state.nextStep, {
      research: "research",
      strategist: "strategist",
      end: END,
    })
    .compile();
}

function defaultRunId(clock: () => Date): string {
  return `run_${clock().toISOString().slice(0, 10)}_${randomUUID().slice(0, 8)}`;
}

// Never throws. Returns a validated FinalResponse or a StructuredError.
export async function runOkaneGraph(
  request: unknown,
  options: OkaneGraphOptions = {},
): Promise<OkaneGraphResult> {
  try {
    const parsedRequest = ResearchRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Research request did not match the expected shape",
          agent: "request_validator",
        },
      };
    }
    const clock = options.clock ?? (() => new Date());
    const runtime: Runtime = {
      agents: { ...defaultAgents, ...options.agents },
      timer: options.timer ?? (() => performance.now()),
      clock,
    };
    const requestId = (options.newRunId ?? (() => defaultRunId(clock)))();

    const graph = buildGraph(runtime);
    const finalState = await graph.invoke(
      { requestId, request: parsedRequest.data },
      { recursionLimit: GRAPH_DEFAULTS.recursionLimit },
    );

    if (finalState.status === "ERROR") {
      return {
        ok: false,
        error: finalState.errors.at(-1) ?? { code: "UNKNOWN", message: "The run ended in an error" },
      };
    }
    if (finalState.status === "RUNNING") {
      return { ok: false, error: { code: "UNKNOWN", message: "The run ended without a final status" } };
    }
    return buildFinalResponse(finalState, clock);
  } catch {
    return { ok: false, error: { code: "UNKNOWN", message: "Unexpected failure while running the graph" } };
  }
}
