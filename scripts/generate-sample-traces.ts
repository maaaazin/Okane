import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MarketSnapshotSchema,
  TraceEventSchema,
  type ResearchRequest,
} from "../src/lib/contracts";
import marketNormal from "../src/fixtures/market_normal.json";
import marketInsufficient from "../src/fixtures/market_insufficient_data.json";
import { runResearchAgent } from "../src/lib/agents/research";
import { invokeModelSafely } from "../src/lib/safe-model";
import { runOkaneGraph, type GraphAgents } from "../src/lib/graph/okane-graph";
import { getRunTrace } from "../src/lib/trace/trace-store";

// Runs the graph in demo mode against the dated fixtures, with no network, and
// writes the stored run trace as submission evidence. Exits 1 on any problem.

process.env.NEXT_PUBLIC_DEMO_MODE = "true";

const request: ResearchRequest = {
  symbol: "RELIANCE.NS",
  horizonDays: 5,
  portfolioValueInr: 1_000_000,
  mode: "paper",
};

function researchWith(market: unknown): GraphAgents["research"] {
  const snapshot = MarketSnapshotSchema.parse(market);
  return (req, observeSnapshot) => {
    observeSnapshot(snapshot);
    return runResearchAgent(req, {
      getMarketSnapshot: async () => ({ ok: true, snapshot }),
      invokeModel: invokeModelSafely,
    });
  };
}

const scenarios = [
  { file: "sample_trace.json", market: marketNormal },
  { file: "sample_trace_insufficient_data.json", market: marketInsufficient },
];

async function main(): Promise<boolean> {
  const outDir = join("docs", "evidence");
  mkdirSync(outDir, { recursive: true });
  let failed = false;

  for (const { file, market } of scenarios) {
    const path = join(outDir, file);
    const result = await runOkaneGraph(request, { agents: { research: researchWith(market) } });
    if (!result.ok) {
      failed = true;
      console.error(`FAIL ${path}: graph returned ${result.error.code}`);
      continue;
    }
    const events = getRunTrace(result.response.requestId);
    if (events === undefined || events.length === 0) {
      failed = true;
      console.error(`FAIL ${path}: no stored trace for the run`);
      continue;
    }
    const invalid = events.filter((event) => !TraceEventSchema.safeParse(event).success);
    if (invalid.length > 0) {
      failed = true;
      console.error(`FAIL ${path}: ${invalid.length} event(s) do not match TraceEventSchema`);
      continue;
    }
    writeFileSync(path, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    console.log(`ok   ${path} (${events.length} events, status ${result.response.status})`);
  }
  return !failed;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  () => {
    console.error("FAIL: sample trace generation threw an unexpected error");
    process.exit(1);
  },
);
