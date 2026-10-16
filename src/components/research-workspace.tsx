"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  ApprovalStatusSchema,
  DemoScenarioSchema,
  FinalResponseSchema,
  PaperTradeSchema,
  ResearchRequestSchema,
  StructuredErrorSchema,
  type DemoScenario,
  type FinalResponse,
  type HumanDecision,
  type PaperTrade,
  type ResearchRequest,
  type StructuredError,
} from "@/lib/contracts";
import {
  PaperTradeList,
  PaperTradeReceipt,
  PaperTradingBanner,
  decisionOutcomeText,
} from "@/components/paper-trading-banner";
import { formatDateTime } from "@/components/format-date";
import { TracePanel } from "@/components/trace-panel";
import {
  DEMO_SCENARIO_NOTICE,
  DEMO_SCENARIO_OPTIONS,
  dataModeBadgeText,
} from "@/components/trace-view-model";

type FormFields = {
  symbol: string;
  horizonDays: string;
  portfolioValueInr: string;
  thesis: string;
};

const INITIAL_FIELDS: FormFields = {
  symbol: "RELIANCE.NS",
  horizonDays: "5",
  portfolioValueInr: "1000000",
  thesis: "",
};

function clientRequest(fields: FormFields): ResearchRequest | StructuredError {
  const candidate = {
    symbol: fields.symbol.trim().toUpperCase(),
    horizonDays: Number(fields.horizonDays),
    portfolioValueInr: Number(fields.portfolioValueInr),
    ...(fields.thesis.trim() === "" ? {} : { thesis: fields.thesis.trim() }),
    mode: "paper" as const,
  };
  const parsed = ResearchRequestSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return {
    code: "INVALID_REQUEST",
    message: "Enter a symbol, a horizon between 1 and 10 days, and a positive portfolio value.",
    agent: "request_validator",
  };
}

function ErrorNotice({ error }: { error: StructuredError }) {
  return (
    <div className="error-notice" role="alert">
      <strong>Research could not start.</strong>
      <span>{error.message}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: FinalResponse["status"] }) {
  const label = status.replaceAll("_", " ");
  return <span className={`status status-${status.toLowerCase()}`}>{label}</span>;
}

function DecisionPanel({
  response,
  trade,
  onDecide,
}: {
  response: FinalResponse;
  trade: PaperTrade | null;
  onDecide: (decision: HumanDecision) => Promise<StructuredError | null>;
}) {
  const [isSending, setIsSending] = useState(false);
  const [decisionError, setDecisionError] = useState<StructuredError | null>(null);
  const canDecide =
    response.status === "AWAITING_HUMAN_APPROVAL" && response.approvalStatus === "PENDING_HUMAN";

  async function decide(decision: HumanDecision) {
    setIsSending(true);
    setDecisionError(await onDecide(decision));
    setIsSending(false);
  }

  return (
    <div className="decision-panel">
      <p className="metric-label">Human decision</p>
      <p>{decisionOutcomeText(response.status, response.approvalStatus)}</p>
      {canDecide ? (
        <div className="decision-actions">
          <button type="button" disabled={isSending} onClick={() => void decide("APPROVE")}>
            Approve paper trade
          </button>
          <button type="button" disabled={isSending} onClick={() => void decide("REJECT")}>
            Reject
          </button>
        </div>
      ) : null}
      {decisionError === null ? null : (
        <p className="decision-error" role="alert">{decisionError.message}</p>
      )}
      {trade === null ? null : <PaperTradeReceipt trade={trade} />}
    </div>
  );
}

function ResultCard({
  response,
  trade,
  onDecide,
}: {
  response: FinalResponse;
  trade: PaperTrade | null;
  onDecide: (decision: HumanDecision) => Promise<StructuredError | null>;
}) {
  const proposal = response.tradeProposal;
  const traceHref = `/api/trace/${encodeURIComponent(response.requestId)}`;

  return (
    <section className="result-card" aria-live="polite" aria-labelledby="research-result-title">
      <div className="result-heading">
        <div>
          <p className="eyebrow">Research result</p>
          <h2 id="research-result-title">{response.request.symbol}</h2>
        </div>
        <StatusBadge status={response.status} />
      </div>

      <PaperTradingBanner />

      <p className={`data-badge data-badge-${response.dataMode}`}>{dataModeBadgeText(response.dataMode)}</p>

      {response.dataMode === "fixture" ? <p className="demo-label">{response.demoLabel}</p> : null}

      {proposal === undefined ? (
        <div className="no-trade">
          <h3>No paper trade proposed</h3>
          <p>{response.evaluation.notes}</p>
        </div>
      ) : (
        <div className="proposal-grid">
          <div className="proposal-primary">
            <p className="metric-label">Proposed direction</p>
            <p className={`direction direction-${proposal.direction.toLowerCase()}`}>{proposal.direction}</p>
            <p className="rationale">{proposal.rationale}</p>
          </div>
          <dl className="metrics">
            <div><dt>Entry</dt><dd>₹{proposal.entry.toFixed(2)}</dd></div>
            <div><dt>Target</dt><dd>₹{proposal.target.toFixed(2)}</dd></div>
            <div><dt>Stop loss</dt><dd>₹{proposal.stop.toFixed(2)}</dd></div>
            <div><dt>Maximum size</dt><dd>{response.riskReview.positionSizeShares} shares</dd></div>
          </dl>
        </div>
      )}

      <div className="result-details">
        <div>
          <p className="metric-label">Evidence</p>
          <ul className="evidence-list">
            {response.evidence.map((evidence) => (
              <li key={evidence.id}>
                <p>{evidence.summary}</p>
                <span>{evidence.source} · retrieved {formatDateTime(evidence.retrievedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="audit-panel">
          <p className="metric-label">Audit trail</p>
          <p><strong>Trace ID</strong><br />{response.requestId}</p>
          <p><strong>Risk decision</strong><br />{response.riskReview.decision}</p>
          <p><strong>Evaluation score</strong><br />{response.evaluation.score}/100</p>
          <a className="trace-link" href={traceHref}>Download execution trace</a>
        </div>
      </div>

      <TracePanel
        runId={response.requestId}
        events={response.trace}
        status={response.status}
        dataMode={response.dataMode}
      />

      <DecisionPanel response={response} trade={trade} onDecide={onDecide} />

      <p className="disclaimer">{response.disclaimer}</p>
    </section>
  );
}

export function ResearchWorkspace({
  initialTrades = [],
  demoMode = false,
}: {
  initialTrades?: readonly PaperTrade[];
  demoMode?: boolean;
}) {
  const [scenario, setScenario] = useState<DemoScenario>("normal");
  const [trades, setTrades] = useState<readonly PaperTrade[]>(initialTrades);
  const [resultTrade, setResultTrade] = useState<PaperTrade | null>(null);
  const [fields, setFields] = useState<FormFields>(INITIAL_FIELDS);
  const [result, setResult] = useState<FinalResponse | null>(null);
  const [error, setError] = useState<StructuredError | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const requestPreview = useMemo(() => clientRequest(fields), [fields]);

  function setField(field: keyof FormFields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setResultTrade(null);
    setError(null);
    if ("code" in requestPreview) {
      setError(requestPreview);
      return;
    }

    setIsRunning(true);
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only the scenario name is sent, and only while demo mode is on.
        body: JSON.stringify(demoMode ? { ...requestPreview, scenario } : requestPreview),
      });
      const body: unknown = await response.json();
      const parsedResult = FinalResponseSchema.safeParse(body);
      if (response.ok && parsedResult.success) {
        setResult(parsedResult.data);
        return;
      }
      const parsedError = StructuredErrorSchema.safeParse(
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error: unknown }).error
          : undefined,
      );
      setError(
        parsedError.success
          ? parsedError.data
          : { code: "UNKNOWN", message: "The research service returned an unexpected response." },
      );
    } catch {
      setError({ code: "NETWORK_ERROR", message: "Unable to reach the research service. Please try again." });
    } finally {
      setIsRunning(false);
    }
  }

  // The server judges the decision from its stored run. The browser only shows the outcome.
  async function decide(decision: HumanDecision): Promise<StructuredError | null> {
    if (result === null) return null;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(result.requestId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body: unknown = await response.json();
      if (response.ok) {
        const approvalStatus = ApprovalStatusSchema.safeParse(
          typeof body === "object" && body !== null && "approvalStatus" in body
            ? (body as { approvalStatus: unknown }).approvalStatus
            : undefined,
        );
        const trade = PaperTradeSchema.nullable().safeParse(
          typeof body === "object" && body !== null && "trade" in body
            ? (body as { trade: unknown }).trade
            : undefined,
        );
        if (approvalStatus.success && trade.success) {
          setResult({ ...result, approvalStatus: approvalStatus.data });
          const recorded = trade.data;
          if (recorded !== null) {
            setResultTrade(recorded);
            setTrades((current) => [...current, recorded]);
          }
          return null;
        }
      }
      const parsedError = StructuredErrorSchema.safeParse(
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error: unknown }).error
          : undefined,
      );
      return parsedError.success
        ? parsedError.data
        : { code: "UNKNOWN", message: "The service returned an unexpected response." };
    } catch {
      return { code: "NETWORK_ERROR", message: "Unable to record the decision. Please try again." };
    }
  }

  return (
    <main className="workspace">
      <section className="workspace-hero" aria-labelledby="page-title">
        <p className="eyebrow">Raccoon Fanclub · CA3</p>
        <h1 id="page-title">Okane</h1>
        <p className="lede">A multi-agent research workspace for human-approved paper trading of Indian equities.</p>
      </section>

      {demoMode ? (
        <div className="scenario-picker">
          <label>
            Demo scenario
            <select
              value={scenario}
              onChange={(event) => {
                const parsed = DemoScenarioSchema.safeParse(event.target.value);
                if (parsed.success) setScenario(parsed.data);
              }}
            >
              {DEMO_SCENARIO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p className="scenario-notice">{DEMO_SCENARIO_NOTICE}</p>
        </div>
      ) : null}

      <section className="research-layout" aria-label="Paper-trading research workspace">
        <form className="research-form" onSubmit={submit} noValidate>
          <div className="form-heading">
            <p className="eyebrow">New research run</p>
            <h2>Frame a paper-trade question</h2>
          </div>
          <label>
            NSE symbol
            <input value={fields.symbol} onChange={(event) => setField("symbol", event.target.value)} placeholder="RELIANCE.NS" autoComplete="off" required />
          </label>
          <div className="form-row">
            <label>
              Horizon (days)
              <input type="number" min="1" max="10" value={fields.horizonDays} onChange={(event) => setField("horizonDays", event.target.value)} required />
            </label>
            <label>
              Portfolio value (INR)
              <input type="number" min="1" step="1" value={fields.portfolioValueInr} onChange={(event) => setField("portfolioValueInr", event.target.value)} required />
            </label>
          </div>
          <label>
            Optional thesis
            <textarea value={fields.thesis} onChange={(event) => setField("thesis", event.target.value)} placeholder="What should the agents investigate?" rows={4} />
          </label>
          <button type="submit" disabled={isRunning}>
            {isRunning ? "Agents are researching…" : "Run paper-trading research"}
          </button>
          <p className="form-note">Runs remain in paper mode. A human must approve before any paper trade is recorded.</p>
          <p className="form-note">Educational paper trading only. Not financial advice. No real orders are placed.</p>
        </form>

        <aside className="agent-overview" aria-label="Agent workflow">
          <p className="eyebrow">How this run is checked</p>
          <ol>
            <li><strong>Research</strong><span>Gathers and validates market evidence.</span></li>
            <li><strong>Strategist</strong><span>Builds a cited paper-trade hypothesis.</span></li>
            <li><strong>Risk Guardrail</strong><span>Can revise or veto unsafe proposals.</span></li>
            <li><strong>Evaluator</strong><span>Audits evidence quality and decision confidence.</span></li>
          </ol>
        </aside>
      </section>

      {error === null ? null : <ErrorNotice error={error} />}
      {result === null ? null : <ResultCard response={result} trade={resultTrade} onDecide={decide} />}
      <PaperTradeList trades={trades} />
    </main>
  );
}
