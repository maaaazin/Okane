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

