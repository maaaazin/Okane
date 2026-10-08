import "server-only";

import { z } from "zod";
import {
  ResearchBriefSchema,
  ResearchRequestSchema,
  TradeProposalSchema,
  type ResearchBrief,
  type ResearchRequest,
  type StructuredError,
  type TradeProposal,
} from "@/lib/contracts";
import { MOCK_MODEL_LABEL, type ModelSource } from "@/lib/model-factory";
import { invokeModelSafely, type SafeModelRequest, type SafeModelResult } from "@/lib/safe-model";
import { buildStrategistPrompt } from "@/lib/agents/strategist-prompts";

const MAX_REFERENCE_DEVIATION = 0.2;
const MIN_CONFIDENCE = 0.1;

const DecisionSchema = z.enum(["BUY", "SELL", "HOLD", "NO_TRADE"]);
export type StrategistDecision = z.infer<typeof DecisionSchema>;

export const StrategistModelOutputSchema = z
  .object({
    decision: DecisionSchema,
    entry: z.number().positive().nullable(),
    target: z.number().positive().nullable(),
    stop: z.number().positive().nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(800),
    evidenceIds: z.array(z.string().min(1)).min(1).max(5),
    reason: z.string().trim().min(1).max(400).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const trade = value.decision === "BUY" || value.decision === "SELL";
    if (trade && (value.entry === null || value.target === null || value.stop === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "BUY and SELL decisions require entry, target, and stop",
      });
    }
    if (!trade && (value.entry !== null || value.target !== null || value.stop !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "HOLD and NO_TRADE decisions must not include trade prices",
      });
    }
    if (!trade && value.reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "No-trade decisions need a reason" });
    }
  });
export type StrategistModelOutput = z.infer<typeof StrategistModelOutputSchema>;

export type StrategistAgentResult =
  | { ok: true; kind: "PROPOSAL"; proposal: TradeProposal; modelSource: ModelSource }
  | {
      ok: true;
      kind: "NO_TRADE";
      decision: "HOLD" | "NO_TRADE";
      reason: string;
      modelSource: ModelSource | "none";
    }
  | { ok: false; error: StructuredError; modelSource: ModelSource | "none" };

// Injectable so unit tests do not call a model or read environment configuration.
export type StrategistAgentDeps = {
  invokeModel: <T>(request: SafeModelRequest<T>) => Promise<SafeModelResult<T>>;
};

const defaultDeps: StrategistAgentDeps = { invokeModel: invokeModelSafely };

function agentError(code: string, message: string): StructuredError {
  return { code, message, agent: "strategist" };
}

function priceFromEvidence(brief: ResearchBrief): number | undefined {
  for (const item of brief.evidence) {
    const match = /(?:latest price is|closed at)\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(
      item.summary,
    );
    if (match !== null) {
      const price = Number(match[1].replaceAll(",", ""));
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return undefined;
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildMockResponse(
  brief: ResearchBrief,
  referencePrice: number,
): StrategistModelOutput {
  const evidenceIds = brief.evidence.slice(0, 3).map((item) => item.id);
  return {
    decision: "BUY",
    entry: roundPrice(referencePrice),
    target: roundPrice(referencePrice * 1.04),
    stop: roundPrice(referencePrice * 0.98),
    confidence: Math.max(MIN_CONFIDENCE, Math.min(brief.confidence, 0.6)),
    rationale: `${MOCK_MODEL_LABEL}: This is a deterministic paper-trade hypothesis based only on ${evidenceIds.map((id) => `[${id}]`).join(" ")}.`,
    evidenceIds,
  };
}

function validateOutput(
  output: StrategistModelOutput,
  request: ResearchRequest,
  brief: ResearchBrief,
  referencePrice: number,
): StructuredError | undefined {
  const validIds = new Set(brief.evidence.map((item) => item.id));
  if (output.evidenceIds.some((id) => !validIds.has(id))) {
    return agentError("INVALID_OUTPUT", "Strategist cited an evidence ID that is not in the Research brief");
  }
  if (output.evidenceIds.some((id) => !output.rationale.includes(`[${id}]`))) {
    return agentError("INVALID_OUTPUT", "Strategist rationale must cite every selected evidence ID");
  }
  if (output.decision === "HOLD" || output.decision === "NO_TRADE") return undefined;

  const { entry, target, stop } = output;
  if (entry === null || target === null || stop === null) {
    return agentError("INVALID_OUTPUT", "Trade proposal is missing a price");
  }
  if (Math.abs(entry - referencePrice) / referencePrice > MAX_REFERENCE_DEVIATION) {
    return agentError("INVALID_OUTPUT", "Proposal entry is too far from the evidence-backed reference price");
  }
  if (output.decision === "BUY" && !(target > entry && stop < entry)) {
    return agentError("INVALID_OUTPUT", "BUY proposal requires target above and stop below entry");
  }
  if (output.decision === "SELL" && !(target < entry && stop > entry)) {
    return agentError("INVALID_OUTPUT", "SELL proposal requires target below and stop above entry");
  }
  if (request.horizonDays < 1 || request.horizonDays > 10) {
    return agentError("INVALID_REQUEST", "Research request horizon is outside the supported range");
  }
  return undefined;
}

// Never throws. It is intentionally unable to create a TradeProposal until the
// Research Agent has supplied usable evidence and a reference price.
export async function runStrategistAgent(
  request: ResearchRequest,
  researchBrief: ResearchBrief,
  deps: StrategistAgentDeps = defaultDeps,
): Promise<StrategistAgentResult> {
  try {
    const parsedRequest = ResearchRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { ok: false, error: agentError("INVALID_REQUEST", "Research request did not match the expected shape"), modelSource: "none" };
    }
    const parsedBrief = ResearchBriefSchema.safeParse(researchBrief);
    if (!parsedBrief.success) {
      return { ok: false, error: agentError("INVALID_RESEARCH_BRIEF", "Research brief did not match the expected shape"), modelSource: "none" };
    }
    const brief = parsedBrief.data;
    if (brief.symbol !== parsedRequest.data.symbol) {
      return { ok: false, error: agentError("INVALID_RESEARCH_BRIEF", "Research brief symbol does not match the request"), modelSource: "none" };
    }
    if (brief.status !== "EVIDENCE_READY" || brief.dataQuality === "INSUFFICIENT") {
      return {
        ok: true,
        kind: "NO_TRADE",
        decision: "NO_TRADE",
        reason: "A trade proposal cannot be created without sufficient research evidence",
        modelSource: "none",
      };
    }
    const referencePrice = priceFromEvidence(brief);
    if (referencePrice === undefined) {
      return {
        ok: true,
        kind: "NO_TRADE",
        decision: "NO_TRADE",
        reason: "Research evidence has no usable reference price for a safe paper-trade proposal",
        modelSource: "none",
      };
    }

    const modelResult = await deps.invokeModel({
      prompt: buildStrategistPrompt(parsedRequest.data, brief, referencePrice),
      schema: StrategistModelOutputSchema,
      agent: "strategist",
      mockResponse: buildMockResponse(brief, referencePrice),
    });
    if (!modelResult.ok) {
      return { ok: false, error: { ...modelResult.error, agent: "strategist" }, modelSource: modelResult.source };
    }
    const output = StrategistModelOutputSchema.safeParse(modelResult.output);
    if (!output.success) {
      return { ok: false, error: agentError("INVALID_OUTPUT", "Model output did not match the expected schema"), modelSource: modelResult.source };
    }
    const validationError = validateOutput(output.data, parsedRequest.data, brief, referencePrice);
    if (validationError !== undefined) {
      return { ok: false, error: validationError, modelSource: modelResult.source };
    }
    if (output.data.decision === "HOLD" || output.data.decision === "NO_TRADE") {
      return {
        ok: true,
        kind: "NO_TRADE",
        decision: output.data.decision,
        reason: output.data.reason ?? "The Strategist did not find a valid trade setup",
        modelSource: modelResult.source,
      };
    }
    const proposal = TradeProposalSchema.safeParse({
      symbol: parsedRequest.data.symbol,
      direction: output.data.decision,
      entry: output.data.entry,
      target: output.data.target,
      stop: output.data.stop,
      horizonDays: parsedRequest.data.horizonDays,
      rationale: output.data.rationale,
      confidence: output.data.confidence,
      evidenceIds: output.data.evidenceIds,
    });
    if (!proposal.success) {
      return { ok: false, error: agentError("INVALID_OUTPUT", "Trade proposal failed validation"), modelSource: modelResult.source };
    }
    return { ok: true, kind: "PROPOSAL", proposal: proposal.data, modelSource: modelResult.source };
  } catch {
    return { ok: false, error: agentError("UNKNOWN", "Unexpected Strategist Agent failure"), modelSource: "none" };
  }
}
