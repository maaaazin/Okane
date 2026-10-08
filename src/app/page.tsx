const readiness = [
  ["Research", "Market evidence and source-quality checks"],
  ["Strategist", "Structured paper-trade hypothesis"],
  ["Risk Guardrail", "Sizing, stop-loss, and no-trade veto"],
  ["Evaluator", "Quality, bias, and trace checks"],
];

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Raccoon Fanclub · CA3</p>
        <h1 id="page-title">Okane</h1>
        <p className="lede">
          A multi-agent, human-approved research workspace for paper trading Indian equities.
        </p>
        <p className="notice">
          Educational research only. Okane never places real trades.
        </p>
      </section>

      <section aria-labelledby="agents-title">
        <div className="section-heading">
          <p className="eyebrow">System status</p>
          <h2 id="agents-title">Four agents, one auditable decision</h2>
        </div>
        <div className="agent-grid">
          {readiness.map(([agent, responsibility], index) => (
            <article className="agent-card" key={agent}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{agent}</h3>
              <p>{responsibility}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="next-step" aria-labelledby="next-step-title">
        <p className="eyebrow">In progress</p>
        <h2 id="next-step-title">The research workflow is being connected.</h2>
        <p>
          The next issues add validated market data, the conditional LangGraph workflow,
          execution traces, and the paper-trade approval screen.
        </p>
      </section>
    </main>
  );
}
