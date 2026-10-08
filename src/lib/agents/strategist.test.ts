import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ResearchBriefSchema,
  type ResearchBrief,
  type ResearchRequest,
} from "@/lib/contracts";
import {
  runStrategistAgent,
  type StrategistAgentDeps,
  type StrategistModelOutput,
} from "@/lib/agents/strategist";
import { invokeModelSafely } from "@/lib/safe-model";

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

const readyBrief = ResearchBriefSchema.parse({
  symbol: "RELIANCE.NS",
  status: "EVIDENCE_READY",
  evidence: [
    {
      id: "ev_001",
      source: "fixture",
      summary: "Latest price is 100.00 INR with improving volume.",
      asOf: "2026-10-08",
      retrievedAt: "2026-10-08T10:00:00.000Z",
      quality: "HIGH",
    },
    {
      id: "ev_002",
      source: "fixture",
      summary: "The last five sessions show a positive recovery.",
      asOf: "2026-10-08",
      retrievedAt: "2026-10-08T10:00:00.000Z",
      quality: "MEDIUM",
    },
  ],
  confidence: 0.65,
  dataQuality: "GOOD",
  reasons: ["Fixture market evidence is usable"],
  source: "fixture",
  retrievedAt: "2026-10-08T10:00:00.000Z",
  dataMode: "fixture",
  demoLabel: "DEMO DATA",
  modelSource: "mock",
});

function noEvidenceBrief(): ResearchBrief {
  return ResearchBriefSchema.parse({
    symbol: "RELIANCE.NS",
    status: "INSUFFICIENT_EVIDENCE",
    evidence: [],
    confidence: 0,
    dataQuality: "INSUFFICIENT",
    reasons: ["Provider timed out"],
    modelSource: "none",
  });
}

type Spy = { deps: StrategistAgentDeps; modelCalls: () => number };

function makeDeps(reply?: unknown): Spy {
  let calls = 0;
  return {
    deps: {
      invokeModel: async (input) => {
        calls += 1;
        return reply === undefined ? invokeModelSafely(input) : (reply as never);
      },
    },
    modelCalls: () => calls,
  };
}

function buyOutput(overrides: Partial<StrategistModelOutput> = {}): StrategistModelOutput {
  return {
    decision: "BUY",
    entry: 100,
    target: 108,
    stop: 96,
    confidence: 0.6,
    rationale: "The proposal is based on [ev_001] and [ev_002].",
    evidenceIds: ["ev_001", "ev_002"],
    ...overrides,
  };
}

describe("runStrategistAgent", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "true";
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
  });

  it("builds a schema-valid, cited paper-trade proposal from evidence-ready research", async () => {
    const spy = makeDeps({ ok: true, output: buyOutput(), source: "claude" });
    const result = await runStrategistAgent(request, readyBrief, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok || result.kind !== "PROPOSAL") return;
    assert.equal(result.proposal.direction, "BUY");
    assert.equal(result.proposal.entry, 100);
    assert.equal(result.proposal.target, 108);
    assert.equal(result.proposal.stop, 96);
    assert.equal(result.proposal.horizonDays, 5);
    assert.deepEqual(result.proposal.evidenceIds, ["ev_001", "ev_002"]);
    assert.match(result.proposal.rationale, /\[ev_001\]/);
    assert.equal(result.modelSource, "claude");
    assert.equal(spy.modelCalls(), 1);
  });

  it("does not call the model or create a proposal without sufficient research", async () => {
    const spy = makeDeps({ ok: true, output: buyOutput(), source: "claude" });
    const result = await runStrategistAgent(request, noEvidenceBrief(), spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "NO_TRADE");
    assert.equal(result.decision, "NO_TRADE");
    assert.equal(result.modelSource, "none");
    assert.equal(spy.modelCalls(), 0);
  });

  it("supports a cited HOLD outcome without emitting a trade proposal", async () => {
    const spy = makeDeps({
      ok: true,
      output: {
        decision: "HOLD",
        entry: null,
        target: null,
        stop: null,
        confidence: 0.3,
        rationale: "The evidence is mixed [ev_001].",
        evidenceIds: ["ev_001"],
        reason: "No clear risk-adjusted setup is available",
      },
      source: "claude",
    });
    const result = await runStrategistAgent(request, readyBrief, spy.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "NO_TRADE");
    assert.equal(result.decision, "HOLD");
    assert.equal("proposal" in result, false);
  });

  it("rejects invented evidence IDs, missing citations, and invalid price orientation", async () => {
    const unknownEvidence = makeDeps({
      ok: true,
      output: buyOutput({ evidenceIds: ["ev_fake"], rationale: "Claim [ev_fake]." }),
      source: "claude",
    });
    const first = await runStrategistAgent(request, readyBrief, unknownEvidence.deps);
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.error.code, "INVALID_OUTPUT");

    const missingCitation = makeDeps({
      ok: true,
      output: buyOutput({ rationale: "No citation here." }),
      source: "claude",
    });
    const second = await runStrategistAgent(request, readyBrief, missingCitation.deps);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "INVALID_OUTPUT");

    const badStop = makeDeps({
      ok: true,
      output: buyOutput({ stop: 102 }),
      source: "claude",
    });
    const third = await runStrategistAgent(request, readyBrief, badStop.deps);
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.error.code, "INVALID_OUTPUT");
  });

  it("produces a deterministic mock proposal in demo mode", async () => {
    const spy = makeDeps();
    const first = await runStrategistAgent(request, readyBrief, spy.deps);
    const second = await runStrategistAgent(request, readyBrief, spy.deps);
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    if (!first.ok || first.kind !== "PROPOSAL") return;
    assert.equal(first.modelSource, "mock");
    assert.match(first.proposal.rationale, /MOCK_MODEL_DEMO_ONLY/);
    assert.equal(first.proposal.horizonDays, request.horizonDays);
  });
});
