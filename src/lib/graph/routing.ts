import "server-only";

import { GRAPH_DEFAULTS } from "@/lib/config";
import type {
  Evaluation,
  ResearchBrief,
  RiskReview,
  RunStatus,
  TradeProposal,
} from "@/lib/contracts";
import type { StrategistAgentResult } from "@/lib/agents/strategist";

// Pure routing rules for the Okane graph. Each function turns one agent result
// into the next step, the run status and a human readable route reason. The
// graph nodes call these and write the answer to state, so the conditional
// edges and the trace can never disagree.

export type NextStep = "research" | "strategist" | "risk_guardrail" | "evaluator" | "end";

export type RouteDecision = {
  next: NextStep;
  status: RunStatus;
  reason: string;
  // Which revision counter this route spends, if any.
  spends?: "research" | "strategy";
};

function end(status: RunStatus, reason: string): RouteDecision {
  return { next: "end", status, reason };
}

export function routeAfterResearch(brief: ResearchBrief): RouteDecision {
  if (
    brief.status !== "EVIDENCE_READY" ||
    brief.dataQuality === "INSUFFICIENT" ||
    brief.evidence.length === 0
  ) {
    return end(
      "INSUFFICIENT_EVIDENCE",
      `Research reported missing, stale or unusable evidence: ${brief.reasons[0]}`,
    );
  }
  return {
    next: "strategist",
    status: "RUNNING",
    reason: "Evidence is usable, hand off to the Strategist",
  };
}

export function routeAfterStrategist(result: StrategistAgentResult): RouteDecision {
  if (!result.ok) {
    return end("NO_TRADE", `Strategist failed (${result.error.code}), run closes without a trade`);
  }
  if (result.kind === "NO_TRADE") {
    return end("NO_TRADE", `Strategist did not propose a trade (${result.decision}): ${result.reason}`);
  }
  return {
    next: "risk_guardrail",
    status: "RUNNING",
    reason: "Proposal is complete, hand off to the Risk Guardrail",
  };
}

export function routeAfterRisk(review: RiskReview, strategyRevisionCount: number): RouteDecision {
  if (review.decision === "APPROVE") {
    return {
      next: "evaluator",
      status: "RUNNING",
      reason: "Risk Guardrail approved the proposal, hand off to the Evaluator",
    };
  }
  if (review.decision === "REVISE") {
    if (strategyRevisionCount < GRAPH_DEFAULTS.maxStrategyRevisions) {
      return {
        next: "strategist",
        status: "RUNNING",
        reason: `Risk Guardrail asked for a revision, one bounded retry: ${review.reasons.join("; ")}`,
        spends: "strategy",
      };
    }
    return end("NO_TRADE", "Risk Guardrail asked for another revision but the revision limit is reached");
  }
  return end("NO_TRADE", `Risk Guardrail rejected the proposal: ${review.reasons[0]}`);
}

export type EvaluationRouteContext = {
  proposal: TradeProposal | null;
  riskReview: RiskReview | null;
  researchRevisionCount: number;
  strategyRevisionCount: number;
};

export function routeAfterEvaluation(
  evaluation: Evaluation,
  context: EvaluationRouteContext,
): RouteDecision {
  const summary = `score ${evaluation.score}, flags: ${evaluation.flags.join(", ") || "none"}`;
  switch (evaluation.nextRoute) {
    case "HUMAN_APPROVAL":
      if (context.proposal !== null && context.riskReview?.decision === "APPROVE") {
        return end("AWAITING_HUMAN_APPROVAL", `Evaluator permitted human approval (${summary})`);
      }
      return end(
        "NO_TRADE",
        "Evaluator permitted approval but a proposal with a Risk Guardrail approval is missing",
      );
    case "RESEARCH":
      if (context.researchRevisionCount < GRAPH_DEFAULTS.maxResearchRevisions) {
        return {
          next: "research",
          status: "RUNNING",
          reason: `Evaluator found a research gap, one bounded retry (${summary})`,
          spends: "research",
        };
      }
      return end("NO_TRADE", `Evaluator asked for more research but the revision limit is reached (${summary})`);
    case "STRATEGIST":
      if (context.strategyRevisionCount < GRAPH_DEFAULTS.maxStrategyRevisions) {
        return {
          next: "strategist",
          status: "RUNNING",
          reason: `Evaluator found a strategy gap, one bounded retry (${summary})`,
          spends: "strategy",
        };
      }
      return end("NO_TRADE", `Evaluator asked for a new proposal but the revision limit is reached (${summary})`);
    case "NO_TRADE":
    case "END":
      return end("NO_TRADE", `Evaluator closed the run without a trade (${summary})`);
  }
}
