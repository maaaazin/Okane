import type { ResearchBrief, ResearchRequest } from "@/lib/contracts";

export const STRATEGIST_SYSTEM_PROMPT = [
  "You are the Strategist Agent in an educational paper-trading research system for Indian equities.",
  "Turn only the supplied Research brief into one conservative, falsifiable paper-trade hypothesis.",
  "You may choose BUY, SELL, HOLD, or NO_TRADE. HOLD and NO_TRADE are valid outcomes when the evidence is weak or ambiguous.",
  "Never claim you executed a trade and never give financial advice.",
  "Every rationale must cite the supplied evidence IDs in square brackets, for example [ev_001].",
  "Use the supplied reference price only as a planning anchor. Do not invent sources, news, dates, or evidence IDs.",
  "Return JSON only, with no markdown or extra text.",
].join("\n");

export function buildStrategistPrompt(
  request: ResearchRequest,
  brief: ResearchBrief,
  referencePrice: number,
): string {
  const evidence = brief.evidence.map((item) => ({
    id: item.id,
    summary: item.summary,
    quality: item.quality,
    asOf: item.asOf,
  }));

  return [
    STRATEGIST_SYSTEM_PROMPT,
    "",
    "REQUEST",
    JSON.stringify({
      symbol: request.symbol,
      horizonDays: request.horizonDays,
      thesis: request.thesis ?? null,
      mode: request.mode,
    }),
    "",
    `REFERENCE PRICE: ${referencePrice.toFixed(2)} INR`,
    "",
    "RESEARCH EVIDENCE",
    JSON.stringify(evidence),
    "",
    "Return exactly one JSON object in this shape:",
    '{"decision":"BUY | SELL | HOLD | NO_TRADE","entry":number|null,"target":number|null,"stop":number|null,"confidence":number,"rationale":"text with [evidence_id] citations","evidenceIds":["ev_001"],"reason":"required only for HOLD or NO_TRADE"}',
    "For BUY or SELL, entry, target, and stop must be positive numbers. For HOLD or NO_TRADE, set them to null.",
  ].join("\n");
}
