import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TradeProposal } from "@/lib/contracts";
import {
  RISK_LIMITS,
  calculatePositionSize,
  calculateRiskRewardRatio,
  calculateStopDistance,
  runRiskGuardrail,
} from "@/lib/agents/risk";

const validBuy: TradeProposal = {
  symbol: "RELIANCE.NS",
  direction: "BUY",
  entry: 1450,
  target: 1510,
  stop: 1420,
  horizonDays: 5,
  rationale: "Fixture evidence supports a paper-trade hypothesis [ev_001].",
  confidence: 0.62,
  evidenceIds: ["ev_001"],
};

describe("Risk Guardrail calculations", () => {
  it("calculates stop distance, risk/reward, and maximum-risk position size", () => {
    assert.equal(calculateStopDistance(1450, 1420), 30);
    assert.equal(calculateRiskRewardRatio("BUY", 1450, 1510, 1420), 2);
    assert.deepEqual(calculatePositionSize(1_000_000, 30), {
      positionSizeShares: 333,
      maxLossInr: 9990,
    });
  });

  it("calculates SELL-side reward correctly", () => {
    assert.equal(calculateRiskRewardRatio("SELL", 1450, 1390, 1480), 2);
  });

  it("returns null for missing, zero, or incorrectly oriented prices", () => {
    assert.equal(calculateStopDistance(1450, 1450), null);
    assert.equal(calculateStopDistance(1450, 0), null);
    assert.equal(calculateRiskRewardRatio("BUY", 1450, 1440, 1420), null);
    assert.equal(calculateRiskRewardRatio("SELL", 1450, 1460, 1480), null);
    assert.equal(calculatePositionSize(1_000_000, null), null);
  });
});

describe("runRiskGuardrail", () => {
  it("approves a valid proposal with deterministic size, loss, and ratio", () => {
    const result = runRiskGuardrail(validBuy, 1_000_000);
    assert.equal(result.decision, "APPROVE");
    assert.equal(result.positionSizeShares, 333);
    assert.equal(result.maxLossInr, 9990);
    assert.equal(result.riskRewardRatio, 2);
  });

  it("rejects a malformed proposal with a safe reason", () => {
    const result = runRiskGuardrail({ ...validBuy, stop: undefined }, 1_000_000);
    assert.equal(result.decision, "REJECT");
    assert.equal(result.positionSizeShares, 0);
    assert.match(result.reasons[0], /missing required/i);
  });

  it("rejects an invalid stop/target orientation", () => {
    const result = runRiskGuardrail({ ...validBuy, stop: 1470 }, 1_000_000);
    assert.equal(result.decision, "REJECT");
    assert.equal(result.riskRewardRatio, null);
    assert.match(result.reasons[0], /invalid stop or target orientation/i);
  });

  it("rejects a proposal when one share exceeds the risk budget", () => {
    const result = runRiskGuardrail({ ...validBuy, stop: 1 }, 10_000);
    assert.equal(result.decision, "REJECT");
    assert.equal(result.positionSizeShares, 0);
    assert.match(result.reasons[0], /risk budget/i);
  });

  it("requires revision when risk-reward is below the stated minimum", () => {
    const result = runRiskGuardrail({ ...validBuy, target: 1480 }, 1_000_000);
    assert.equal(result.decision, "REVISE");
    assert.equal(result.riskRewardRatio, 1);
    assert.equal(result.positionSizeShares, 333);
    assert.match(result.reasons[0], /below the 1.5 minimum/i);
  });

  it("uses a one-percent risk budget", () => {
    assert.equal(RISK_LIMITS.maxRiskPercent, 0.01);
  });
});
