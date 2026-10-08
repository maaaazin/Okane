# Okane — Teammate and Agent Guide

## Read this first

Okane is a course project for **Agentic AI CA3**, built by Raccoon Fanclub. It is a **human-approved paper-trading research system for Indian equities**. It must demonstrate four genuinely agentic, LLM-driven agents that communicate, challenge one another, and adapt their route when evidence or risk checks require it.

This repository is not a real trading platform. It must never submit orders to a broker, ask for brokerage credentials, present a result as financial advice, or claim a market-data feed is real-time without verified provider entitlement.

The project is intentionally scoped for a short hackathon build:

- Support one or two pre-tested NSE symbols only.
- Support a 1–10 trading-day swing-research horizon.
- Produce `AWAITING_HUMAN_APPROVAL`, `NO_TRADE`, or `INSUFFICIENT_EVIDENCE`.
- Record a paper trade only after a human presses Approve.
- Make the execution trace visible so evaluators can verify agent coordination.

## Current state

The Next.js App Router foundation is implemented under `src/app/`. The homepage is a project-status shell only. The agent graph, market-data adapter, traces, and approval screen are **planned work**, not functionality that exists yet.

Before editing, read:

1. `docs/PROJECT_ROADMAP.md` for the full delivery plan and team ownership.
2. `docs/ARCHITECTURE.md` for the system boundaries, contracts, and routing rules.

## Team ownership

| Person | Primary ownership | Review focus |
|---|---|---|
| Mohammad Ahmad | Market/news adapters, fixtures, Research Agent, evidence provenance | Data quality, citations, no fabricated facts |
| Kazi Maazin Azim | Next.js UI, server routes, LangGraph.js state/routing, Strategist Agent | Graph correctness, typed contracts, integration |
| Janak Fabyani | Risk Guardrail, Evaluator, traces, tests, deployment/quality | Veto logic, safe fallbacks, demonstrable evidence |

Ownership avoids overlap; it does not prevent reviewing another member's code or helping to unblock them. Do not rewrite another person's in-progress work without coordinating through the issue/PR.

## Core architecture

The system uses **Next.js + Node.js + TypeScript**, **LangChain.js**, and **LangGraph.js**. The graph owns decisions and conditional routing. UI components and route handlers only collect input, invoke the graph, and display state; they do not decide which agent should run next.

The four assessment-critical agents are:

1. **Research Agent** — retrieves/normalizes market evidence, records source/timestamp, and calls out insufficient evidence.
2. **Strategist Agent** — forms a falsifiable paper-trade hypothesis with entry, target, stop, horizon, rationale, and confidence.
3. **Risk Guardrail Agent** — independently validates stop distance, maximum position size, and risk/reward; it can veto with `REJECT` or request `REVISE`.
4. **Evaluator Agent** — assesses source/citation quality, data freshness, unsupported claims, latency, and overall decision quality; it can request a revision or permit human approval.

Use one shared, Zod-validated graph state. Agents must return structured data; do not pass free-form strings as a substitute for contracts. Every agent transition adds a trace event.

## Required graph behaviour

Normal route:

`Research → Strategist → Risk Guardrail → Evaluator → AWAITING_HUMAN_APPROVAL`

Adaptive routes that must exist and appear in saved traces:

- Research determines data is missing, stale, or unusable → `INSUFFICIENT_EVIDENCE` / `NO_TRADE`.
- Risk returns `REVISE` → Strategist receives the explicit constraints and gets one bounded revision attempt.
- Risk returns `REJECT` → `NO_TRADE`.
- Evaluator finds unsupported or low-quality output → Research or Strategist gets one bounded revision attempt.
- A human rejects/does not approve → no paper trade is written.

Never build a rigid sequence that proceeds despite a failure. Never allow unbounded loops. Put a maximum revision count in shared state and include the route reason in the trace.

## Data, model, and safety rules

- Market providers are behind a single adapter. Return normalized data, provider name, retrieval timestamp, and data-quality status.
- Use dated local fixtures for automated tests and demo reliability. A fixture must be visibly labelled as demo/cached data in the UI and trace.
- Never scrape a provider that forbids it. Check current terms, rate limits, attribution, and coverage before adding a provider.
- All model/API keys are server-only environment variables. Never use `NEXT_PUBLIC_` for secrets and never commit `.env.local`.
- Model failure, timeout, malformed structured output, missing data, and rate limiting must produce a safe structured outcome—not a crash and not a fabricated recommendation.
- Every final output contains the paper-trading/educational disclaimer.
- “No trade” is a correct and valuable result when evidence is insufficient or risk is unacceptable.

## Proposed source layout

Use this layout as issues are implemented. Do not create a parallel architecture without discussion.

```text
src/
  app/
    api/research/route.ts       # server entry point for graph runs
    page.tsx                    # request/result UI
  components/
    research-form.tsx
    recommendation-card.tsx
    trace-panel.tsx
  lib/
    contracts.ts                # shared Zod schemas + inferred types
    config.ts                   # validated server configuration
    data/market-data.ts         # provider adapter + fixture fallback
    agents/
      research.ts
      strategist.ts
      risk.ts
      evaluator.ts
    graph/okane-graph.ts        # LangGraph.js nodes and conditional edges
    trace/run-trace.ts          # append-only trace helper
    paper-trades.ts             # approval-gated persistence interface
  fixtures/
    normal.json
    insufficient-data.json
```

## Implementation conventions

- Use TypeScript strict mode. Prefer `unknown` plus Zod parsing over `any`.
- Keep client components small; keep secrets, model calls, provider calls, and graph logic server-side.
- Define a function's inputs/outputs with shared schemas, then write the smallest correct implementation.
- Deterministic calculations such as risk/reward, position size, and stop-distance validation must be ordinary tested functions—not LLM judgement.
- LLMs explain or reason over evidence; they must not invent prices, URLs, timestamps, or calculation results.
- Add source/timestamp/fallback information to trace events and user-visible result metadata.
- Use meaningful names and small modules. Avoid a giant `utils.ts` or a giant route handler containing all agents.

## Testing standard

Every feature PR needs an appropriate test or documented reason it cannot yet be tested. At minimum, preserve these cases:

1. Normal evidence → valid proposal → risk accepts → evaluator permits approval.
2. Missing/stale/provider-failed evidence → `INSUFFICIENT_EVIDENCE` or `NO_TRADE`.
3. Invalid stop/excessive risk → `REJECT` or `REVISE`, never approval.
4. Revision counter is bounded; graph cannot loop indefinitely.
5. Rejected or unapproved proposal never creates a paper trade.

Run before requesting review:

```bash
npm run lint
npm run typecheck
# add npm test once the Vitest suite lands
```

## Git and pull-request workflow

1. Start from an assigned issue. Use `feature/issue-<number>-short-description`.
2. Keep a PR to one focused issue and include `Closes #<number>` in its description.
3. Include: what changed, how it was tested, a trace/sample impact if agent routing changed, and limitations/fallbacks.
4. A teammate must leave a substantive review before merging P0 work. Respond to review comments rather than silently changing scope.
5. Use focused commits such as `feat(risk): reject zero stop distance` or `test(graph): cover evaluator revision route`.
6. Do not commit generated build files, dependencies, API keys, or a teammate's work under your GitHub identity.

## Definition of a good contribution

A contribution is complete only when the code, tests, trace behaviour, and documentation agree. For agent work, a screenshot alone is not evidence: save a real trace that identifies agent, route reason, tool/data status, and final outcome.

If a decision is unclear, prefer the smallest safe implementation that preserves these CA3 goals: four distinct agents, evidence-backed outputs, adaptive coordination, human-approved simulation, and verifiable execution traces.
