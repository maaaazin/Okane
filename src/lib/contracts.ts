import { z } from "zod";

// Shared contracts for Okane. Every other module imports types from here
// and never re declares them. One schema per concept, inferred type beside it.

const isoTimestamp = z.iso.datetime();
const isoDate = z.iso.date();

export const DISCLAIMER =
  "Educational paper trading research only. Not financial advice. No real orders are placed.";

export const DataModeSchema = z.enum(["provider", "fixture"]);
export type DataMode = z.infer<typeof DataModeSchema>;

export const DataQualitySchema = z.enum(["GOOD", "DEGRADED", "INSUFFICIENT"]);
export type DataQuality = z.infer<typeof DataQualitySchema>;

export const RunStatusSchema = z.enum([
  "RUNNING",
  "AWAITING_HUMAN_APPROVAL",
  "NO_TRADE",
  "INSUFFICIENT_EVIDENCE",
  "ERROR",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ApprovalStatusSchema = z.enum([
  "PENDING_HUMAN",
  "APPROVED",
  "REJECTED",
  "NOT_APPLICABLE",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const AgentNameSchema = z.enum([
  "request_validator",
  "research",
  "strategist",
  "risk_guardrail",
  "evaluator",
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const StructuredErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    agent: AgentNameSchema.optional(),
  })
  .strict();
export type StructuredError = z.infer<typeof StructuredErrorSchema>;

export const ResearchRequestSchema = z
  .object({
    symbol: z.string().min(1),
    horizonDays: z.number().int().min(1).max(10),
    portfolioValueInr: z.number().positive(),
    thesis: z.string().min(1).optional(),
    mode: z.literal("paper"),
  })
  .strict();
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const EvidenceQualitySchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>;

export const EvidenceSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    summary: z.string().min(1),
    asOf: isoDate,
    retrievedAt: isoTimestamp,
    quality: EvidenceQualitySchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

export const TradeProposalSchema = z
  .object({
    symbol: z.string().min(1),
    direction: TradeDirectionSchema,
    entry: z.number().positive(),
    target: z.number().positive(),
    stop: z.number().positive(),
    horizonDays: z.number().int().min(1).max(10),
    rationale: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

export const RiskDecisionSchema = z.enum(["APPROVE", "REVISE", "REJECT"]);
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

export const RiskReviewSchema = z
  .object({
    decision: RiskDecisionSchema,
    positionSizeShares: z.number().int().nonnegative(),
    maxLossInr: z.number().nonnegative(),
    riskRewardRatio: z.number().nonnegative().nullable(),
    reasons: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type RiskReview = z.infer<typeof RiskReviewSchema>;

export const EvaluationFlagSchema = z.enum([
  "UNSUPPORTED_CLAIM",
  "MISSING_CITATION",
  "STALE_DATA",
  "OVERCONFIDENT",
  "THIN_EVIDENCE",
  "SLOW_RUN",
]);
export type EvaluationFlag = z.infer<typeof EvaluationFlagSchema>;

export const NextRouteSchema = z.enum([
  "HUMAN_APPROVAL",
  "RESEARCH",
  "STRATEGIST",
  "NO_TRADE",
  "END",
]);
export type NextRoute = z.infer<typeof NextRouteSchema>;

export const EvaluationSchema = z
  .object({
    score: z.number().min(0).max(100),
    flags: z.array(EvaluationFlagSchema),
    nextRoute: NextRouteSchema,
    notes: z.string().min(1),
  })
  .strict();
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const TraceEventSchema = z
  .object({
    runId: z.string().min(1),
    at: isoTimestamp,
    agent: AgentNameSchema,
    event: z.enum(["started", "completed", "failed", "routed"]),
    inputSummary: z.string().min(1),
    outputSummary: z.string().min(1),
    routeReason: z.string().min(1),
    elapsedMs: z.number().int().nonnegative(),
    dataMode: DataModeSchema,
    error: StructuredErrorSchema.nullable(),
  })
  .strict();
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const FinalResponseSchema = z
  .object({
    requestId: z.string().min(1),
    asOf: isoDate,
    dataMode: DataModeSchema,
    demoLabel: z.string().min(1).optional(),
    request: ResearchRequestSchema,
    status: RunStatusSchema,
    approvalStatus: ApprovalStatusSchema,
    dataQuality: DataQualitySchema,
    evidence: z.array(EvidenceSchema),
    tradeProposal: TradeProposalSchema.optional(),
    riskReview: RiskReviewSchema,
    evaluation: EvaluationSchema,
    trace: z.array(TraceEventSchema).min(1),
    errors: z.array(StructuredErrorSchema),
    disclaimer: z.literal(DISCLAIMER),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataMode === "fixture" && value.demoLabel === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["demoLabel"],
        message: "Fixture data must carry a visible demo label",
      });
    }
    if (value.status === "AWAITING_HUMAN_APPROVAL") {
      if (value.tradeProposal === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tradeProposal"],
          message: "Awaiting approval requires a trade proposal",
        });
      }
      if (value.riskReview.decision !== "APPROVE") {
        ctx.addIssue({
          code: "custom",
          path: ["riskReview", "decision"],
          message: "Awaiting approval requires risk APPROVE",
        });
      }
      if (value.evaluation.nextRoute !== "HUMAN_APPROVAL") {
        ctx.addIssue({
          code: "custom",
          path: ["evaluation", "nextRoute"],
          message: "Awaiting approval requires evaluator permission",
        });
      }
    }
    if (
      value.approvalStatus === "PENDING_HUMAN" &&
      value.status !== "AWAITING_HUMAN_APPROVAL"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["approvalStatus"],
        message: "Pending human approval requires AWAITING_HUMAN_APPROVAL status",
      });
    }
  });
export type FinalResponse = z.infer<typeof FinalResponseSchema>;

export const FreshnessSchema = z.enum(["delayed", "end_of_day", "fixture", "real_time"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const OhlcBarSchema = z
  .object({
    date: isoDate,
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().int().nonnegative(),
  })
  .strict();
export type OhlcBar = z.infer<typeof OhlcBarSchema>;

export const MarketSnapshotSchema = z
  .object({
    symbol: z.string().min(1),
    exchange: z.string().min(1),
    currency: z.string().min(1),
    bars: z.array(OhlcBarSchema),
    quotePrice: z.number().positive(),
    source: z.string().min(1),
    retrievedAt: isoTimestamp,
    dataMode: DataModeSchema,
    dataQuality: DataQualitySchema,
    // Never defaults. "real_time" is only accepted with the explicit flag below.
    freshness: FreshnessSchema,
    realTimeEntitlementVerified: z.literal(true).optional(),
    // Fixture data carries a visible label and the date it was captured.
    demoLabel: z.string().min(1).optional(),
    asOf: isoDate.optional(),
    fromCache: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.freshness === "real_time" && value.realTimeEntitlementVerified !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "real_time freshness requires realTimeEntitlementVerified",
      });
    }
    if (value.dataMode === "fixture") {
      if (value.freshness !== "fixture") {
        ctx.addIssue({
          code: "custom",
          path: ["freshness"],
          message: "Fixture data must have fixture freshness",
        });
      }
      if (value.demoLabel === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["demoLabel"],
          message: "Fixture data must carry a visible demo label",
        });
      }
      if (value.asOf === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["asOf"],
          message: "Fixture data must carry an as of date",
        });
      }
    } else if (value.freshness === "fixture") {
      ctx.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "Fixture freshness requires fixture data mode",
      });
    }
  });
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const ResearchStatusSchema = z.enum(["EVIDENCE_READY", "INSUFFICIENT_EVIDENCE"]);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

// Where the brief text came from. "none" means no model call was made.
export const ResearchModelSourceSchema = z.enum(["claude", "mock", "none"]);
export type ResearchModelSource = z.infer<typeof ResearchModelSourceSchema>;

// The Research Agent output. The source fields are copied from the market
// snapshot and are absent only when no snapshot could be retrieved at all.
export const ResearchBriefSchema = z
  .object({
    symbol: z.string().min(1),
    status: ResearchStatusSchema,
    evidence: z.array(EvidenceSchema),
    confidence: z.number().min(0).max(1),
    dataQuality: DataQualitySchema,
    reasons: z.array(z.string().min(1)).min(1),
    source: z.string().min(1).optional(),
    retrievedAt: isoTimestamp.optional(),
    dataMode: DataModeSchema.optional(),
    demoLabel: z.string().min(1).optional(),
    modelSource: ResearchModelSourceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataMode === "fixture" && value.demoLabel === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["demoLabel"],
        message: "Fixture data must carry a visible demo label",
      });
    }
    if (value.status === "EVIDENCE_READY") {
      if (value.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "Evidence ready requires at least one evidence item",
        });
      }
      if (value.dataQuality === "INSUFFICIENT") {
        ctx.addIssue({
          code: "custom",
          path: ["dataQuality"],
          message: "Evidence ready cannot have insufficient data quality",
        });
      }
      if (
        value.source === undefined ||
        value.retrievedAt === undefined ||
        value.dataMode === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "Evidence ready requires source, retrievedAt and dataMode",
        });
      }
    }
  });
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;
