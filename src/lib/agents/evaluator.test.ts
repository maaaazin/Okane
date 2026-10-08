import { test, describe } from "node:test";
import assert from "node:assert";
import { runEvaluatorAgent } from "./evaluator";
import type { EvaluatorInput } from "@/lib/contracts";

// Import fixtures using require to bypass strict module types for JSON if needed
// or parse them directly
import * as fs from "node:fs";
import * as path from "node:path";

const normalData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/fixtures/normal.json"), "utf8")
);
const insufficientData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/fixtures/insufficient_data.json"), "utf8")
);

function buildNormalInput(): EvaluatorInput {
  const data = structuredClone(normalData);
  return {
    brief: {
      symbol: data.tradeProposal.symbol,
      status: "EVIDENCE_READY",
      evidence: data.evidence,
      confidence: 0.8,
      dataQuality: data.dataQuality,
      reasons: ["Test reason"],
      source: "Test source",
      retrievedAt: "2026-10-08T09:55:00.000Z",
      dataMode: data.dataMode,
      demoLabel: data.demoLabel,
      modelSource: "mock",
    },
    proposal: data.tradeProposal,
    riskReview: data.riskReview,
    timings: [
      { agent: "research", elapsedMs: 1000 },
      { agent: "strategist", elapsedMs: 1000 },
      { agent: "risk_guardrail", elapsedMs: 200 },
    ],
    counters: {
      researchRevisionCount: 0,
      strategyRevisionCount: 0,
    },
  };
}

function buildInsufficientInput(): EvaluatorInput {
  const data = structuredClone(insufficientData);
  return {
    brief: {
      symbol: data.request.symbol,
      status: data.status,
      evidence: data.evidence,
      confidence: 0,
      dataQuality: data.dataQuality,
      reasons: ["Insufficient data"],
      modelSource: "none",
    },
    proposal: null,
    riskReview: data.riskReview,
    timings: [
      { agent: "research", elapsedMs: 950 },
    ],
    counters: {
      researchRevisionCount: 0,
      strategyRevisionCount: 0,
    },
  };
}

describe("Evaluator Agent", () => {
  test("1. Healthy normal fixture with an APPROVE risk review routes to human approval with a high score and no serious flags", () => {
    const input = buildNormalInput();
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "HUMAN_APPROVAL");
    assert.strictEqual(result.evaluation.flags.length, 0);
    assert.ok(result.evaluation.score >= 70);
  });

  test("2. insufficient_data fixture with REJECT routes to the end with no trade", () => {
    const input = buildInsufficientInput();
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "END");
  });

  test("3. A brief with INSUFFICIENT_EVIDENCE routes to the end and never to human approval", () => {
    const input = buildNormalInput();
    input.brief.status = "INSUFFICIENT_EVIDENCE";
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "END");
    assert.ok(result.evaluation.flags.includes("THIN_EVIDENCE"));
  });

  test("4. An evidence item with an empty source is flagged and lowers the score", () => {
    const input = buildNormalInput();
    input.brief.evidence[0].source = " "; // Space passes Zod min(1) but fails our trim() check
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.flags.includes("MISSING_CITATION"));
    assert.ok(result.evaluation.score < 100);
  });

  test("5. Proposal confidence above brief confidence is flagged as overconfident", () => {
    const input = buildNormalInput();
    input.brief.confidence = 0.5;
    input.proposal!.confidence = 0.8;
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.flags.includes("OVERCONFIDENT"));
  });

  test("6. Degraded data quality with high proposal confidence is flagged", () => {
    const input = buildNormalInput();
    input.brief.dataQuality = "DEGRADED";
    input.brief.confidence = 0.6;
    input.proposal!.confidence = 0.6; // Assuming DEGRADED_CONFIDENCE_CAP is 0.5
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.flags.includes("OVERCONFIDENT"));
    assert.ok(result.evaluation.flags.includes("STALE_DATA"));
  });

  test("7. REVISE with budget left routes to the Strategist", () => {
    const input = buildNormalInput();
    input.riskReview!.decision = "REVISE";
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "STRATEGIST");
  });

  test("8. REVISE with no budget left routes to the end", () => {
    const input = buildNormalInput();
    input.riskReview!.decision = "REVISE";
    input.counters.strategyRevisionCount = 1;
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "END");
  });

  test("9. Slow timings lower the score but do not block approval on their own", () => {
    const input = buildNormalInput();
    input.timings.push({ agent: "strategist", elapsedMs: 10000 }); // Exceeds maxAgentMs
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.flags.includes("SLOW_RUN"));
    assert.strictEqual(result.evaluation.nextRoute, "HUMAN_APPROVAL");
  });

  test("10. Missing riskReview with a proposal present does not allow human approval", () => {
    const input = buildNormalInput();
    input.riskReview = null;
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.strictEqual(result.evaluation.nextRoute, "END");
    assert.strictEqual(result.evaluation.flags.length, 0);
    assert.ok(result.evaluation.notes.includes("Missing risk review"));
  });

  test("11. Fixture data mode adds the demo data flag (to notes) and is not treated as an error", () => {
    const input = buildNormalInput();
    input.brief.dataMode = "fixture";
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.notes.includes("Run used demo data."));
    assert.strictEqual(result.evaluation.flags.length, 0);
    assert.strictEqual(result.evaluation.nextRoute, "HUMAN_APPROVAL");
  });

  test("12. Same input twice gives the identical output", () => {
    const input = buildNormalInput();
    const result1 = runEvaluatorAgent(input);
    const result2 = runEvaluatorAgent(input);
    assert.deepStrictEqual(result1, result2);
  });

  test("13. Bad input (wrong types) returns a StructuredError and does not throw", () => {
    const input = { bad: "input" } as unknown as EvaluatorInput;
    const result = runEvaluatorAgent(input);
    assert.ok(!result.ok);
    assert.strictEqual(result.error.agent, "evaluator");
  });

  test("14. Score is always inside the allowed range, including when many flags stack up", () => {
    const input = buildNormalInput();
    input.brief.status = "INSUFFICIENT_EVIDENCE"; // THIN_EVIDENCE (-40)
    input.brief.dataQuality = "INSUFFICIENT";
    input.proposal!.rationale = " "; // UNSUPPORTED_CLAIM (-20)
    input.proposal!.confidence = 1; // OVERCONFIDENT (-15) because brief.confidence is 0.8
    input.timings.push({ agent: "research", elapsedMs: 20000 }); // SLOW_RUN (-5)
    input.brief.evidence[0].source = " "; // MISSING_CITATION (-20)
    
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(result.evaluation.score >= 0);
    assert.ok(result.evaluation.score <= 100);
  });

  test("15. Provider data mode does not add the demo data note", () => {
    const input = buildNormalInput();
    input.brief.dataMode = "provider";
    const result = runEvaluatorAgent(input);
    assert.ok(result.ok);
    assert.ok(!result.evaluation.notes.includes("Run used demo data."));
    assert.strictEqual(result.evaluation.nextRoute, "HUMAN_APPROVAL");
  });
});
