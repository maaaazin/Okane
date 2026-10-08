import "server-only";

import {
  DISCLAIMER,
  FinalResponseSchema,
  OkaneStateSchema,
  type DataMode,
  type Evaluation,
  type FinalResponse,
  type RiskReview,
  type StructuredError,
} from "@/lib/contracts";
import type { OkaneGraphStateType } from "@/lib/graph/state";

// Used only when a fixture brief somehow carries no label, so the response still
// satisfies the contract and the data stays visibly marked as demo data.
const FALLBACK_DEMO_LABEL = "DEMO DATA: cached fixture, not live market data";

export type FinalResponseResult =
  | { ok: true; response: FinalResponse }
  | { ok: false; error: StructuredError };

function invalid(message: string): FinalResponseResult {
  return { ok: false, error: { code: "INVALID_OUTPUT", message } };
}

// The contract requires a risk review and an evaluation on every response. When
// a stage did not run, a clearly worded stand in is used instead of nothing.
function standInRiskReview(reason: string): RiskReview {
  return {
    decision: "REJECT",
    positionSizeShares: 0,
    maxLossInr: 0,
    riskRewardRatio: null,
    reasons: [`The Risk Guardrail did not issue an approval for this run: ${reason}`],
  };
}

function standInEvaluation(state: OkaneGraphStateType): Evaluation {
  return {
    score: 0,
    flags: state.status === "INSUFFICIENT_EVIDENCE" ? ["THIN_EVIDENCE"] : [],
    nextRoute: "END",
    notes: `The Evaluator did not run for this outcome: ${state.routeReason}`,
  };
}

// Never throws. Validates the state and the response before returning either.
export function buildFinalResponse(
  state: OkaneGraphStateType,
  clock: () => Date,
): FinalResponseResult {
  const checkedState = OkaneStateSchema.safeParse({
    requestId: state.requestId,
    request: state.request,
    marketSnapshot: state.marketSnapshot,
    evidence: state.evidence,
    researchBrief: state.researchBrief,
    tradeProposal: state.tradeProposal,
    riskReview: state.riskReview,
    evaluation: state.evaluation,
    trace: state.trace,
    routeReason: state.routeReason,
    researchRevisionCount: state.researchRevisionCount,
    strategyRevisionCount: state.strategyRevisionCount,
    status: state.status,
    errors: state.errors,
  });
  if (!checkedState.success) return invalid("Graph state failed validation");

  const brief = state.researchBrief;
  const snapshot = state.marketSnapshot;
  const dataMode: DataMode = brief?.dataMode ?? snapshot?.dataMode ?? "provider";
  const demoLabel =
    brief?.demoLabel ?? snapshot?.demoLabel ?? (dataMode === "fixture" ? FALLBACK_DEMO_LABEL : undefined);
  const asOf =
    snapshot?.asOf ?? brief?.retrievedAt?.slice(0, 10) ?? clock().toISOString().slice(0, 10);
  const awaiting = state.status === "AWAITING_HUMAN_APPROVAL";

  const parsed = FinalResponseSchema.safeParse({
    requestId: state.requestId,
    asOf,
    dataMode,
    ...(demoLabel === undefined ? {} : { demoLabel }),
    request: state.request,
    status: state.status,
    approvalStatus: awaiting ? "PENDING_HUMAN" : "NOT_APPLICABLE",
    dataQuality: brief?.dataQuality ?? "INSUFFICIENT",
    evidence: state.evidence,
    ...(awaiting && state.tradeProposal !== null ? { tradeProposal: state.tradeProposal } : {}),
    riskReview: state.riskReview ?? standInRiskReview(state.routeReason),
    evaluation: state.evaluation ?? standInEvaluation(state),
    trace: state.trace,
    errors: state.errors,
    disclaimer: DISCLAIMER,
  });
  if (!parsed.success) return invalid("Final response failed validation");
  return { ok: true, response: parsed.data };
}
