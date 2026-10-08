import "server-only";

import { z } from "zod";
import {
  EvidenceQualitySchema,
  ResearchBriefSchema,
  ResearchRequestSchema,
  type DataQuality,
  type Evidence,
  type EvidenceQuality,
  type MarketSnapshot,
  type ResearchBrief,
  type ResearchModelSource,
  type ResearchRequest,
  type StructuredError,
} from "@/lib/contracts";
import { getMarketSnapshot, type MarketDataResult } from "@/lib/data/market-data";
import { MOCK_MODEL_LABEL } from "@/lib/model-factory";
import { invokeModelSafely, type SafeModelRequest, type SafeModelResult } from "@/lib/safe-model";
import { buildResearchPrompt } from "@/lib/agents/research-prompts";
import {
  allowedFigures,
  computeFacts,
  formatFactsBlock,
  type ResearchFacts,
} from "@/lib/agents/research-facts";

// Research Agent. Market data only: a retrieval source for curated context can be
// added later and would feed extra evidence into the same brief. The free text
// thesis is deliberately not sent to the model, because it is not evidence.

export const DEGRADED_CONFIDENCE_CAP = 0.5;
const FIGURE_TOLERANCE = 0.06;

export const ResearchModelOutputSchema = z
  .object({
    evidence: z
      .array(
        z
          .object({
            summary: z.string().trim().min(1).max(400),
            quality: EvidenceQualitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(5),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ResearchModelOutput = z.infer<typeof ResearchModelOutputSchema>;

export type ResearchAgentResult =
  | {
      ok: true;
      brief: ResearchBrief;
      modelSource: ResearchModelSource;
      // Set when the market adapter failed and no snapshot exists.
      marketError?: StructuredError;
      // Set when the adapter replaced a failed provider call with a labelled fixture.
      fallbackReason?: StructuredError;
    }
  | { ok: false; error: StructuredError; modelSource: ResearchModelSource };

// Injectable so tests never touch the network or a real model.
export type ResearchAgentDeps = {
  getMarketSnapshot: (symbol: string) => Promise<MarketDataResult>;
  invokeModel: <T>(request: SafeModelRequest<T>) => Promise<SafeModelResult<T>>;
};

const defaultDeps: ResearchAgentDeps = {
  getMarketSnapshot: (symbol) => getMarketSnapshot(symbol),
  invokeModel: invokeModelSafely,
};

function agentError(code: string, message: string): StructuredError {
  return { code, message, agent: "research" };
}

// Deterministic demo reply built only from the computed facts.
export function buildMockResponse(
  facts: ResearchFacts,
  dataQuality: DataQuality,
): ResearchModelOutput {
  const quality: EvidenceQuality = dataQuality === "GOOD" ? "HIGH" : "MEDIUM";
  const changeText = facts.changes
    .map((change) => `${change.percent.toFixed(2)} percent over ${change.sessions} sessions`)
    .join(", ");
  return {
    evidence: [
      {
        summary: `${MOCK_MODEL_LABEL}: Latest price is ${facts.latestPrice.toFixed(2)} ${facts.currency}. Change was ${changeText}.`,
        quality,
      },
      {
        summary: `${MOCK_MODEL_LABEL}: Range high is ${facts.rangeHigh.toFixed(2)} and range low is ${facts.rangeLow.toFixed(2)} across ${facts.barCount} daily bars, with the latest price ${facts.distanceFromHighPercent.toFixed(2)} percent below the range high.`,
        quality,
      },
      {
        summary: `${MOCK_MODEL_LABEL}: Average daily volume is ${facts.averageVolume} shares over the range from ${facts.rangeStartDate} to ${facts.latestBarDate}.`,
        quality,
      },
    ],
    confidence: dataQuality === "GOOD" ? 0.6 : 0.4,
  };
}

// Rejects summaries that mention a figure or link that is not in the facts block.
function findUngroundedClaim(output: ResearchModelOutput, facts: ResearchFacts): string | undefined {
  const allowed = allowedFigures(facts);
  for (const item of output.evidence) {
    if (/https?:|www\./i.test(item.summary)) return "Evidence mentions a link";
    const dates = item.summary.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    if (dates.some((date) => !allowed.dates.includes(date))) return "Evidence mentions an unknown date";
    const withoutDates = item.summary.replace(/\d{4}-\d{2}-\d{2}/g, " ");
    const figures = (withoutDates.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((text) =>
      Number(text.replaceAll(",", "")),
    );
    const unknown = figures.find(
      (figure) => !allowed.numbers.some((known) => Math.abs(known - figure) <= FIGURE_TOLERANCE),
    );
    if (unknown !== undefined) return `Evidence mentions a figure not in the data block: ${unknown}`;
  }
  return undefined;
}

function insufficientBrief(
  symbol: string,
  reasons: string[],
  snapshot?: MarketSnapshot,
): ResearchBrief {
  return ResearchBriefSchema.parse({
    symbol,
    status: "INSUFFICIENT_EVIDENCE",
    evidence: [],
    confidence: 0,
    dataQuality: "INSUFFICIENT",
    reasons,
    ...(snapshot === undefined
      ? {}
      : {
          source: snapshot.source,
          retrievedAt: snapshot.retrievedAt,
          dataMode: snapshot.dataMode,
          ...(snapshot.demoLabel === undefined ? {} : { demoLabel: snapshot.demoLabel }),
        }),
    modelSource: "none",
  });
}

// Never throws. Callers branch on `ok`.
export async function runResearchAgent(
  request: ResearchRequest,
  deps: ResearchAgentDeps = defaultDeps,
): Promise<ResearchAgentResult> {
  try {
    const parsedRequest = ResearchRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return {
        ok: false,
        error: agentError("INVALID_REQUEST", "Research request did not match the expected shape"),
        modelSource: "none",
      };
    }
    const { symbol } = parsedRequest.data;

    const market = await deps.getMarketSnapshot(symbol);
    if (!market.ok) {
      return {
        ok: true,
        brief: insufficientBrief(symbol, [
          `Market data unavailable (${market.error.code}): ${market.error.message}`,
        ]),
        modelSource: "none",
        marketError: market.error,
      };
    }
    const { snapshot } = market;
    const facts = snapshot.dataQuality === "INSUFFICIENT" ? undefined : computeFacts(snapshot);
    if (facts === undefined) {
      return {
        ok: true,
        brief: insufficientBrief(
          snapshot.symbol,
          ["Market data quality is insufficient, so no evidence was written and no model was called"],
          snapshot,
        ),
        modelSource: "none",
        ...(market.fallbackReason === undefined ? {} : { fallbackReason: market.fallbackReason }),
      };
    }

    const modelResult = await deps.invokeModel({
      prompt: buildResearchPrompt(formatFactsBlock(facts)),
      schema: ResearchModelOutputSchema,
      agent: "research",
      mockResponse: buildMockResponse(facts, snapshot.dataQuality),
    });
    if (!modelResult.ok) {
      return {
        ok: false,
        error: { ...modelResult.error, agent: "research" },
        modelSource: modelResult.source,
      };
    }
    const modelSource: ResearchModelSource = modelResult.source;

    const output = ResearchModelOutputSchema.safeParse(modelResult.output);
    if (!output.success) {
      return {
        ok: false,
        error: agentError("INVALID_OUTPUT", "Model output did not match the expected schema"),
        modelSource,
      };
    }
    const ungrounded = findUngroundedClaim(output.data, facts);
    if (ungrounded !== undefined) {
      return { ok: false, error: agentError("INVALID_OUTPUT", ungrounded), modelSource };
    }

    // Rules enforced in code, whatever the model said.
    const degraded = snapshot.dataQuality === "DEGRADED";
    const asOf = snapshot.asOf ?? facts.latestBarDate;
    const evidence: Evidence[] = output.data.evidence.map((item, index) => ({
      id: `ev_${String(index + 1).padStart(3, "0")}`,
      source: snapshot.source,
      summary: item.summary,
      asOf,
      retrievedAt: snapshot.retrievedAt,
      quality: degraded && item.quality === "HIGH" ? "MEDIUM" : item.quality,
    }));
    const confidence = degraded
      ? Math.min(output.data.confidence, DEGRADED_CONFIDENCE_CAP)
      : output.data.confidence;

    const reasons = [
      `Market data quality is ${snapshot.dataQuality} with ${facts.barCount} daily bars from ${snapshot.source}`,
    ];
    if (degraded) {
      reasons.push(`Confidence is capped at ${DEGRADED_CONFIDENCE_CAP} because data quality is DEGRADED`);
    }
    if (snapshot.dataMode === "fixture") {
      reasons.push(snapshot.demoLabel ?? "Fixture data is demo data");
    }
    if (market.fallbackReason !== undefined) {
      reasons.push(
        `Provider failed (${market.fallbackReason.code}), so a labelled fixture was used instead`,
      );
    }
    if (modelSource === "mock") {
      reasons.push(`Evidence text came from the deterministic mock model (${MOCK_MODEL_LABEL})`);
    }

    const brief = ResearchBriefSchema.safeParse({
      symbol: snapshot.symbol,
      status: "EVIDENCE_READY",
      evidence,
      confidence,
      dataQuality: snapshot.dataQuality,
      reasons,
      source: snapshot.source,
      retrievedAt: snapshot.retrievedAt,
      dataMode: snapshot.dataMode,
      ...(snapshot.demoLabel === undefined ? {} : { demoLabel: snapshot.demoLabel }),
      modelSource,
    });
    if (!brief.success) {
      return {
        ok: false,
        error: agentError("INVALID_OUTPUT", "Research brief failed validation"),
        modelSource,
      };
    }
    return {
      ok: true,
      brief: brief.data,
      modelSource,
      ...(market.fallbackReason === undefined ? {} : { fallbackReason: market.fallbackReason }),
    };
  } catch {
    return {
      ok: false,
      error: agentError("UNKNOWN", "Unexpected Research Agent failure"),
      modelSource: "none",
    };
  }
}
