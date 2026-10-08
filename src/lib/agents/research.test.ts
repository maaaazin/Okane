import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MarketSnapshotSchema,
  ResearchBriefSchema,
  StructuredErrorSchema,
  type MarketSnapshot,
  type ResearchRequest,
} from "@/lib/contracts";
import marketNormal from "@/fixtures/market_normal.json";
import marketInsufficient from "@/fixtures/market_insufficient_data.json";
import {
  DEGRADED_CONFIDENCE_CAP,
  runResearchAgent,
  type ResearchAgentDeps,
  type ResearchModelOutput,
} from "@/lib/agents/research";
import { computeFacts } from "@/lib/agents/research-facts";
import { invokeModelSafely } from "@/lib/safe-model";

// Written against node:test, same style as the other tests. The market adapter
// and the model are injected, so no network is used.

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

const normalSnapshot = MarketSnapshotSchema.parse(marketNormal);
const insufficientSnapshot = MarketSnapshotSchema.parse(marketInsufficient);

type MarketReply = Awaited<ReturnType<ResearchAgentDeps["getMarketSnapshot"]>>;
type Spy = { deps: ResearchAgentDeps; modelCalls: () => number };

// Market returns the given result. The model returns `reply` when given, and
// otherwise runs the real safe wrapper, which selects its mock in demo mode.
function makeDeps(market: MarketReply, reply?: unknown): Spy {
  let calls = 0;
  const deps: ResearchAgentDeps = {
    getMarketSnapshot: async () => market,
    invokeModel: async (req) => {
      calls += 1;
      return reply === undefined ? invokeModelSafely(req) : (reply as never);
    },
  };
  return { deps, modelCalls: () => calls };
}

function groundedOutput(snapshot: MarketSnapshot, confidence: number): ResearchModelOutput {
  const facts = computeFacts(snapshot);
  assert.ok(facts);
  return {
    evidence: [
      {
        summary: `Latest price is ${facts.latestPrice.toFixed(2)} and the range high is ${facts.rangeHigh.toFixed(2)}.`,
        quality: "HIGH",
      },
    ],
    confidence,
  };
}

describe("runResearchAgent", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "true";
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
  });

  it("returns EVIDENCE_READY with sourced and dated evidence for a valid fixture", async () => {
    const spy = makeDeps(
      { ok: true, snapshot: normalSnapshot },
      { ok: true, output: groundedOutput(normalSnapshot, 0.7), source: "claude" },
    );
    const result = await runResearchAgent(request, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { brief } = result;
    assert.equal(brief.status, "EVIDENCE_READY");
    assert.equal(brief.modelSource, "claude");
    assert.equal(result.modelSource, "claude");
    assert.equal(brief.source, normalSnapshot.source);
    assert.equal(brief.retrievedAt, normalSnapshot.retrievedAt);
    assert.equal(brief.dataMode, "fixture");
    assert.equal(brief.demoLabel, normalSnapshot.demoLabel);
    assert.ok(brief.evidence.length > 0);
    for (const item of brief.evidence) {
      assert.equal(item.source, normalSnapshot.source);
      assert.equal(item.asOf, normalSnapshot.asOf);
      assert.equal(item.retrievedAt, normalSnapshot.retrievedAt);
    }
    assert.equal(brief.confidence, 0.7);
    assert.equal(spy.modelCalls(), 1);
  });

  it("returns INSUFFICIENT_EVIDENCE and never calls the model on a market error", async () => {
    const error = StructuredErrorSchema.parse({
      code: "TIMEOUT",
      message: "Market data request timed out",
    });
    const spy = makeDeps({ ok: false, error });
    const result = await runResearchAgent(request, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.brief.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(result.brief.evidence.length, 0);
    assert.equal(result.brief.modelSource, "none");
    assert.deepEqual(result.marketError, error);
    assert.equal(ResearchBriefSchema.safeParse(result.brief).success, true);
    assert.equal(spy.modelCalls(), 0);
  });

  it("returns INSUFFICIENT_EVIDENCE and never calls the model on an insufficient snapshot", async () => {
    const spy = makeDeps({ ok: true, snapshot: insufficientSnapshot });
    const result = await runResearchAgent(request, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.brief.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(result.brief.dataQuality, "INSUFFICIENT");
    assert.equal(result.brief.source, insufficientSnapshot.source);
    assert.equal(result.brief.dataMode, "fixture");
    assert.equal(result.brief.modelSource, "none");
    assert.equal(spy.modelCalls(), 0);
  });

  it("does not produce a brief when the model output fails validation", async () => {
    const failed = makeDeps(
      { ok: true, snapshot: normalSnapshot },
      {
        ok: false,
        error: { code: "INVALID_OUTPUT", message: "Model output was not valid JSON" },
        source: "claude",
      },
    );
    const first = await runResearchAgent(request, failed.deps);
    assert.equal(first.ok, false);
    if (first.ok) return;
    assert.equal(first.error.code, "INVALID_OUTPUT");
    assert.equal(first.error.agent, "research");

    // Valid shape, but it cites a price that is not in the data block.
    const invented = makeDeps(
      { ok: true, snapshot: normalSnapshot },
      {
        ok: true,
        output: {
          evidence: [{ summary: "Price reached 9999.99 today.", quality: "HIGH" }],
          confidence: 0.9,
        },
        source: "claude",
      },
    );
    const second = await runResearchAgent(request, invented.deps);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, "INVALID_OUTPUT");
    assert.equal("brief" in second, false);
  });

  it("caps confidence and evidence quality when data is degraded", async () => {
    const degraded = { ...normalSnapshot, dataQuality: "DEGRADED" as const };
    const spy = makeDeps(
      { ok: true, snapshot: degraded },
      { ok: true, output: groundedOutput(degraded, 0.95), source: "claude" },
    );
    const result = await runResearchAgent(request, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.brief.status, "EVIDENCE_READY");
    assert.equal(result.brief.dataQuality, "DEGRADED");
    assert.equal(result.brief.confidence, DEGRADED_CONFIDENCE_CAP);
    assert.ok(result.brief.evidence.every((item) => item.quality !== "HIGH"));
  });

  it("produces a schema valid labelled brief from the mockResponse in demo mode", async () => {
    const spy = makeDeps({ ok: true, snapshot: normalSnapshot });
    const first = await runResearchAgent(request, spy.deps);
    const second = await runResearchAgent(request, spy.deps);
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.modelSource, "mock");
    assert.equal(first.brief.modelSource, "mock");
    assert.equal(first.brief.status, "EVIDENCE_READY");
    assert.equal(first.brief.dataMode, "fixture");
    assert.ok(first.brief.demoLabel);
    assert.equal(ResearchBriefSchema.safeParse(first.brief).success, true);
    assert.ok(first.brief.evidence.every((item) => item.summary.includes("MOCK_MODEL_DEMO_ONLY")));
  });

  it("returns a structured error for an invalid request without throwing", async () => {
    const spy = makeDeps({ ok: true, snapshot: normalSnapshot });
    const result = await runResearchAgent({ ...request, horizonDays: 99 }, spy.deps);
    assert.equal(result.ok, false);
    assert.equal(spy.modelCalls(), 0);
  });
});
