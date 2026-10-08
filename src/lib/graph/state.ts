import "server-only";

import { Annotation } from "@langchain/langgraph";
import type {
  Evaluation,
  Evidence,
  MarketSnapshot,
  ResearchBrief,
  ResearchRequest,
  RiskReview,
  RunStatus,
  StructuredError,
  TraceEvent,
  TradeProposal,
} from "@/lib/contracts";
import type { NextStep } from "@/lib/graph/routing";

// LangGraph channels for the shared state. The shape mirrors OkaneStateSchema in
// contracts.ts, which validates the final state. Optional agent outputs use null
// here so a revision pass can clear them, because an undefined update is ignored.

function lastValue<T>(initial: T) {
  return Annotation<T>({ reducer: (_current, update) => update, default: () => initial });
}

function appendOnly<T>() {
  return Annotation<T[]>({ reducer: (current, update) => current.concat(update), default: () => [] });
}

export const OkaneGraphState = Annotation.Root({
  requestId: Annotation<string>(),
  request: Annotation<ResearchRequest>(),
  marketSnapshot: lastValue<MarketSnapshot | null>(null),
  evidence: lastValue<Evidence[]>([]),
  researchBrief: lastValue<ResearchBrief | null>(null),
  tradeProposal: lastValue<TradeProposal | null>(null),
  riskReview: lastValue<RiskReview | null>(null),
  evaluation: lastValue<Evaluation | null>(null),
  trace: appendOnly<TraceEvent>(),
  routeReason: lastValue<string>("Run started, hand off to Research"),
  researchRevisionCount: lastValue<number>(0),
  strategyRevisionCount: lastValue<number>(0),
  status: lastValue<RunStatus>("RUNNING"),
  errors: appendOnly<StructuredError>(),
  // Written by each node, read by its conditional edge.
  nextStep: lastValue<NextStep>("research"),
});

export type OkaneGraphStateType = typeof OkaneGraphState.State;
export type OkaneGraphUpdate = typeof OkaneGraphState.Update;
