import "server-only";

import { z } from "zod";
import {
  RiskReviewSchema,
  TradeProposalSchema,
  type RiskReview,
  type TradeDirection,
} from "@/lib/contracts";

// These are deliberately plain, deterministic controls. The Risk Guardrail is
// independent of the Strategist and does not use an LLM to calculate money.
export const RISK_LIMITS = {
  maxRiskPercent: 0.01,
  minRiskRewardRatio: 1.5,
} as const;

export type PositionSizing = {
  positionSizeShares: number;
  maxLossInr: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateStopDistance(entry: number, stop: number): number | null {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0) {
    return null;
  }
  const distance = Math.abs(entry - stop);
  return distance > 0 ? roundMoney(distance) : null;
}

export function calculateRiskRewardRatio(
  direction: TradeDirection,
  entry: number,
  target: number,
  stop: number,
): number | null {
  const risk = calculateStopDistance(entry, stop);
  if (
    risk === null ||
    !Number.isFinite(target) ||
    target <= 0 ||
    (direction === "BUY" && (target <= entry || stop >= entry)) ||
    (direction === "SELL" && (target >= entry || stop <= entry))
  ) {
    return null;
  }
  const reward = direction === "BUY" ? target - entry : entry - target;
  return reward > 0 ? roundMoney(reward / risk) : null;
}

export function calculatePositionSize(
  portfolioValueInr: number,
  stopDistance: number | null,
  maxRiskPercent = RISK_LIMITS.maxRiskPercent,
): PositionSizing | null {
  if (
    !Number.isFinite(portfolioValueInr) ||
    portfolioValueInr <= 0 ||
    stopDistance === null ||
    !Number.isFinite(stopDistance) ||
    stopDistance <= 0 ||
    !Number.isFinite(maxRiskPercent) ||
    maxRiskPercent <= 0 ||
    maxRiskPercent > 1
  ) {
    return null;
  }
  const riskBudget = portfolioValueInr * maxRiskPercent;
  const positionSizeShares = Math.floor(riskBudget / stopDistance);
  return {
    positionSizeShares,
    maxLossInr: roundMoney(positionSizeShares * stopDistance),
  };
}

function review(
  decision: RiskReview["decision"],
  positionSizeShares: number,
  maxLossInr: number,
  riskRewardRatio: number | null,
  reasons: string[],
): RiskReview {
  return RiskReviewSchema.parse({
    decision,
    positionSizeShares,
    maxLossInr,
    riskRewardRatio,
    reasons,
  });
}

function reject(reason: string, ratio: number | null = null): RiskReview {
  return review("REJECT", 0, 0, ratio, [reason]);
}

// Accepts unknown because graph/UI boundaries are untrusted. It never throws:
// malformed, incomplete, or unsafe proposals become a safe REJECT review.
export function runRiskGuardrail(
  candidate: unknown,
  portfolioValueInr: unknown,
): RiskReview {
  const proposal = TradeProposalSchema.safeParse(candidate);
  if (!proposal.success) {
    return reject("Proposal is missing required symbol, entry, target, stop, or direction values");
  }
  const portfolio = z.number().positive().safeParse(portfolioValueInr);
  if (!portfolio.success) {
    return reject("Portfolio value must be a positive number before position sizing");
  }

  const stopDistance = calculateStopDistance(proposal.data.entry, proposal.data.stop);
  const riskRewardRatio = calculateRiskRewardRatio(
    proposal.data.direction,
    proposal.data.entry,
    proposal.data.target,
    proposal.data.stop,
  );
  if (stopDistance === null || riskRewardRatio === null) {
    return reject(
      `${proposal.data.direction} proposal has an invalid stop or target orientation relative to entry`,
      riskRewardRatio,
    );
  }

  const sizing = calculatePositionSize(portfolio.data, stopDistance);
  if (sizing === null || sizing.positionSizeShares < 1) {
    return reject(
      `Stop distance of ${stopDistance.toFixed(2)} INR exceeds the ${Math.round(RISK_LIMITS.maxRiskPercent * 100)} percent risk budget for this portfolio`,
      riskRewardRatio,
    );
  }
  if (riskRewardRatio < RISK_LIMITS.minRiskRewardRatio) {
    return review(
      "REVISE",
      sizing.positionSizeShares,
      sizing.maxLossInr,
      riskRewardRatio,
      [
        `Risk to reward is ${riskRewardRatio.toFixed(2)}, below the ${RISK_LIMITS.minRiskRewardRatio.toFixed(1)} minimum`,
        "Revise entry, target, or stop before this paper-trade hypothesis can proceed",
      ],
    );
  }

  return review(
    "APPROVE",
    sizing.positionSizeShares,
    sizing.maxLossInr,
    riskRewardRatio,
    [
      `Stop distance is ${stopDistance.toFixed(2)} INR, which is positive and correctly oriented`,
      `Risk per trade is capped at ${Math.round(RISK_LIMITS.maxRiskPercent * 100)} percent of portfolio value`,
      `Risk to reward is ${riskRewardRatio.toFixed(2)}, meeting the ${RISK_LIMITS.minRiskRewardRatio.toFixed(1)} minimum`,
    ],
  );
}
