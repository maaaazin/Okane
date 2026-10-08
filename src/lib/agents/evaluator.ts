import "server-only";

import {
  EvaluatorInputSchema,
  EvaluationSchema,
  type EvaluatorInput,
  type Evaluation,
  type EvaluationFlag,
  type NextRoute,
  type StructuredError,
} from "@/lib/contracts";
import { EVALUATOR_DEFAULTS } from "@/lib/config";
import { DEGRADED_CONFIDENCE_CAP } from "@/lib/agents/research";

export function runEvaluatorAgent(
  input: EvaluatorInput
): { ok: true; evaluation: Evaluation } | { ok: false; error: StructuredError } {
  try {
    const parsed = EvaluatorInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Evaluator input did not match the expected shape",
          agent: "evaluator",
        },
      };
    }
    const data = parsed.data;

    const flags = new Set<EvaluationFlag>();
    const notes: string[] = [];
    let isInvalid = false;

    // 1. Citations
    if (data.brief.evidence.length === 0) {
      flags.add("THIN_EVIDENCE");
    }
    for (const item of data.brief.evidence) {
      if (!item.source || item.source.trim() === "") {
        flags.add("MISSING_CITATION");
      }
      if (!item.asOf || isNaN(Date.parse(item.asOf))) {
        flags.add("MISSING_CITATION");
      }
    }
    if (data.brief.status === "INSUFFICIENT_EVIDENCE") {
      flags.add("THIN_EVIDENCE");
    }
    if (data.proposal) {
      if (!data.proposal.rationale || data.proposal.rationale.trim() === "") {
        flags.add("UNSUPPORTED_CLAIM");
      }
    }

    // 2. Data quality
    if (data.brief.dataQuality === "INSUFFICIENT") {
      flags.add("THIN_EVIDENCE");
    } else if (data.brief.dataQuality === "DEGRADED") {
      flags.add("STALE_DATA");
    }

    if (data.brief.dataMode === "fixture") {
      notes.push("Run used demo data.");
    }

    // 3. Confidence
    const briefConf = data.brief.confidence;
    const isBriefConfValid =
      typeof briefConf === "number" && !isNaN(briefConf) && briefConf >= 0 && briefConf <= 1;

    if (!isBriefConfValid) {
      flags.add("OVERCONFIDENT");
    }

    if (data.proposal) {
      const propConf = data.proposal.confidence;
      const isPropConfValid =
        typeof propConf === "number" && !isNaN(propConf) && propConf >= 0 && propConf <= 1;

      if (!isPropConfValid) {
        flags.add("OVERCONFIDENT");
      } else {
        if (isBriefConfValid && propConf > briefConf) {
          flags.add("OVERCONFIDENT");
        }
        if (
          data.brief.dataQuality === "DEGRADED" &&
          propConf > DEGRADED_CONFIDENCE_CAP
        ) {
          flags.add("OVERCONFIDENT");
        }
      }
    }

    // 4. Latency
    let totalElapsed = 0;
    let missingTimings = data.timings.length === 0;

    for (const t of data.timings) {
      if (typeof t.elapsedMs !== "number" || isNaN(t.elapsedMs) || t.elapsedMs < 0) {
        missingTimings = true;
      } else {
        totalElapsed += t.elapsedMs;
        if (t.elapsedMs > EVALUATOR_DEFAULTS.maxAgentMs) {
          flags.add("SLOW_RUN");
        }
      }
    }

    if (missingTimings || totalElapsed > EVALUATOR_DEFAULTS.maxTotalMs) {
      flags.add("SLOW_RUN");
    }

    // 5. Risk decision
    if (data.proposal && !data.riskReview) {
      notes.push("Missing risk review for proposal.");
      isInvalid = true; // Incomplete risk review while proposal exists is invalid
    }

    // Score Calculation
    let score: number = EVALUATOR_DEFAULTS.maxScore;
    for (const flag of flags) {
      score -= EVALUATOR_DEFAULTS.penalties[flag] || 0;
    }
    score = Math.max(0, Math.min(EVALUATOR_DEFAULTS.maxScore, score));
    score = Number(score.toFixed(2));

    // Next Route Logic
    let nextRoute: NextRoute;
    const hasSeriousFlag = flags.has("THIN_EVIDENCE");

    if (isInvalid || hasSeriousFlag || data.brief.dataQuality === "INSUFFICIENT") {
      nextRoute = "END";
    } else if (data.riskReview && data.riskReview.decision === "REJECT") {
      nextRoute = "END";
    } else if (
      data.riskReview &&
      data.riskReview.decision === "REVISE" &&
      data.counters.strategyRevisionCount < EVALUATOR_DEFAULTS.maxRevisionCount
    ) {
      nextRoute = "STRATEGIST";
    } else if (
      data.riskReview &&
      data.riskReview.decision === "REVISE" &&
      data.counters.strategyRevisionCount >= EVALUATOR_DEFAULTS.maxRevisionCount
    ) {
      nextRoute = "END";
    } else if (
      data.riskReview &&
      data.riskReview.decision === "APPROVE" &&
      score >= EVALUATOR_DEFAULTS.passThreshold
    ) {
      nextRoute = "HUMAN_APPROVAL";
    } else if (
      // Adjusted for graph integration: a low quality approved proposal gets one
      // bounded pass back to the stage named by the flags, per the architecture doc.
      data.riskReview &&
      data.riskReview.decision === "APPROVE" &&
      flags.has("MISSING_CITATION") &&
      data.counters.researchRevisionCount < EVALUATOR_DEFAULTS.maxRevisionCount
    ) {
      nextRoute = "RESEARCH";
    } else if (
      data.riskReview &&
      data.riskReview.decision === "APPROVE" &&
      (flags.has("UNSUPPORTED_CLAIM") || flags.has("OVERCONFIDENT")) &&
      data.counters.strategyRevisionCount < EVALUATOR_DEFAULTS.maxRevisionCount
    ) {
      nextRoute = "STRATEGIST";
    } else {
      nextRoute = "END";
    }

    if (notes.length === 0) {
      notes.push("Evaluator checks completed.");
    }

    const evaluation = EvaluationSchema.parse({
      score,
      flags: Array.from(flags),
      nextRoute,
      notes: notes.join(" "),
    });

    return { ok: true, evaluation };
  } catch {
    return {
      ok: false,
      error: { code: "UNKNOWN_ERROR", message: "Unexpected evaluator failure", agent: "evaluator" },
    };
  }
}
