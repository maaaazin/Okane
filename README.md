# Okane

Okane is a multi-agent research prototype built by **Raccoon Fanclub** for the Agentic AI CA3 course project. It turns a short-horizon question about an Indian equity into an evidence-backed **paper-trade proposal or a safe no-trade outcome**. The point of the project is to make collaboration visible: specialist agents pass structured findings to one another, challenge weak proposals, and change the route when evidence or risk checks fail.

Okane is for education and demonstration. It does not provide financial advice, connect to a broker, or place real orders.

## What the system does

1. A user enters an NSE symbol, a 1–10 trading-day horizon, a portfolio value in INR, and optionally a research thesis.
2. A LangGraph.js workflow coordinates four specialist stages over shared, Zod-validated state:

   | Stage | Responsibility | Can change the route? |
   | --- | --- | --- |
   | **Research** | Normalizes market data, computes grounded facts, and records evidence with source and retrieval time. | Stops if evidence is unusable. |
   | **Strategist** | Forms a cited BUY/SELL paper-trade hypothesis with entry, target, stop, horizon, rationale, and confidence. | Can decline to propose a trade. |
   | **Risk Guardrail** | Calculates stop distance, position size, maximum loss, and risk/reward independently of the Strategist. | Approves, requests a revision, or rejects. |
   | **Evaluator** | Scores evidence and decision quality, citations, confidence, and run timing. | Permits human review, requests a bounded revision, or ends the run. |

3. The graph returns `AWAITING_HUMAN_APPROVAL`, `NO_TRADE`, or `INSUFFICIENT_EVIDENCE`. Agent failures return structured errors instead of fabricated recommendations.
4. For an approval-ready proposal, the user can press **Approve paper trade** or **Reject**. Only Approve records a simulated trade in the paper-trade list. Reject records no trade. Neither action sends an order to a broker.

Research and Strategist use an OpenAI model through LangChain.js when live model mode is configured. Demo mode uses deterministic mock model responses. Risk Guardrail and Evaluator use deterministic code-based checks; financial calculations are never delegated to an LLM.

## Why this is an agent workflow

The route is conditional rather than a fixed four-step sequence:

```text
Research -- usable evidence --> Strategist --> Risk Guardrail --> Evaluator
    |                                      ^            |                |
    +-- insufficient evidence --> END      +-- REVISE --+                +-- pass --> Human decision
                                                       +-- REJECT --> NO_TRADE
Evaluator -- research gap --> Research (at most once)
Evaluator -- strategy gap --> Strategist (at most once)
Evaluator -- unresolved issue --> NO_TRADE
```

Risk can veto a proposal, and neither the Strategist nor the UI can override that decision. Research and strategy revisions are each limited to one attempt, with an additional graph recursion limit. Every agent transition adds an execution-trace event containing the agent, input and output summaries, elapsed time, data mode, and **route reason**. The result page has an expandable trace panel and a JSON download for assessment.

## Demo the project

The default `.env.example` enables demo mode. Start the app, then use the **Demo scenario** selector:

| Scenario | What to show |
| --- | --- |
| **Normal** | Research → Strategist → Risk Guardrail → Evaluator → human approval. Approve to add a paper trade, or Reject to show that no trade is recorded. |
| **Risk revision** | The first proposal has deliberately weak risk/reward. Risk asks Strategist to revise it once, then reviews the new proposal. The trace shows both visits. |
| **Insufficient data** | Research stops the graph before a proposal is created. The trace contains only the Research stage. |

Demo scenarios run the real graph and checks against dated, labelled fixtures. The first proposal in **Risk revision** is deliberately weakened by scenario code to exercise the real revision route. **All three demo scenarios use the `RELIANCE.NS` fixture and replace the NSE symbol entered in the form with `RELIANCE.NS`.** To research another symbol, turn demo mode off and configure the model and market-data path; its result then depends on provider availability and evidence quality. Fixture data is never presented as live market data.

The normal and insufficient-data example traces are also checked in at [normal trace](docs/evidence/sample_trace.json) and [insufficient-data trace](docs/evidence/sample_trace_insufficient_data.json).

## Run locally

Requires **Node.js 20.9 or later**.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open <http://localhost:3000>. With `NEXT_PUBLIC_DEMO_MODE=true`, the scenario selector needs no model API key and uses saved market fixtures and mock model responses.

For the configured OpenAI-backed path, set `NEXT_PUBLIC_DEMO_MODE=false` and set `OPENAI_API_KEY` in `.env.local` or the deployment's server environment. `OPENAI_MODEL` is an optional model-name override. Never commit `.env.local` or put keys in `NEXT_PUBLIC_` variables. The market-data adapter uses an **unofficial, delayed Yahoo Finance chart endpoint**; it is not an entitled real-time feed, and provider availability is not guaranteed. Market-data failures produce a labelled fixture fallback only in demo mode for its matching symbol, or a safe insufficient-evidence result.

## Verify

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:fixtures
npm run trace:sample
```

The tests cover normal and insufficient-evidence routes, bounded Risk and Evaluator revisions, vetoes, model and provider failure handling, request validation, trace recording, and approval-gated paper-trade decisions. `trace:sample` regenerates the checked-in assessment examples.

## Architecture and limits

- **Stack:** Next.js App Router, TypeScript, LangChain.js, LangGraph.js, and Zod.
- **Market data:** one server-side adapter normalizes provider or fixture data and records its source, retrieval time, quality, and mode. Prices and timestamps are not invented by the model.
- **Risk policy:** position size caps modeled loss at 1% of the portfolio, and a proposal needs a risk/reward ratio of at least 1.5 to pass.
- **Persistence:** run results, traces, and the paper-trade ledger are **in memory**. They can disappear after a server restart or serverless cold start; this is not durable trading infrastructure.
- **Scope:** a short 1–10 day paper-trading research horizon, with a reliable demo fixture for `RELIANCE.NS`. The live provider path depends on delayed third-party data.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts, routing, and trust boundaries, and [AGENTS.md](AGENTS.md) for team conventions. Licensed under [Apache 2.0](LICENSE).
