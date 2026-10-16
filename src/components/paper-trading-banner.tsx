import { PAPER_TRADE_LABEL, type ApprovalStatus, type PaperTrade, type RunStatus } from "@/lib/contracts";
import { formatDateTime } from "@/components/format-date";

export const PAPER_TRADING_BANNER =
  "Paper trading, educational only. No real orders and no real money.";

// Plain sentence describing what happened to a result. Pure, so it can be tested.
export function decisionOutcomeText(status: RunStatus, approvalStatus: ApprovalStatus): string {
  if (approvalStatus === "APPROVED") return "Approved by a human. A simulated trade was recorded.";
  if (approvalStatus === "REJECTED") return "Rejected by a human. Nothing was recorded.";
  if (status === "AWAITING_HUMAN_APPROVAL") return "Waiting for a human decision. Nothing is recorded yet.";
  return "No trade. Nothing was recorded.";
}

export function PaperTradingBanner() {
  return (
    <p className="paper-banner" role="note">
      {PAPER_TRADING_BANNER}
    </p>
  );
}

export function PaperTradeReceipt({ trade }: { trade: PaperTrade }) {
  return (
    <div className="paper-receipt">
      <p className="metric-label">Paper trade receipt</p>
      <dl className="metrics">
        <div><dt>Trade ID</dt><dd>{trade.id}</dd></div>
        <div><dt>Symbol</dt><dd>{trade.symbol} · {trade.direction}</dd></div>
        <div><dt>Entry</dt><dd>₹{trade.entry.toFixed(2)}</dd></div>
        <div><dt>Target</dt><dd>₹{trade.target.toFixed(2)}</dd></div>
        <div><dt>Stop loss</dt><dd>₹{trade.stop.toFixed(2)}</dd></div>
        <div><dt>Size</dt><dd>{trade.positionSizeShares} shares</dd></div>
        <div><dt>Approved at</dt><dd>{formatDateTime(trade.approvedAt)}</dd></div>
        <div><dt>Data</dt><dd>{trade.dataMode} · {trade.source}</dd></div>
      </dl>
      <p className="disclaimer">{PAPER_TRADE_LABEL}</p>
    </div>
  );
}

export function PaperTradeList({ trades }: { trades: readonly PaperTrade[] }) {
  return (
    <section className="paper-ledger" aria-label="Recorded paper trades">
      <p className="metric-label">Recorded paper trades</p>
      {trades.length === 0 ? (
        <p>No paper trades recorded yet.</p>
      ) : (
        <ul className="evidence-list">
          {[...trades].reverse().map((trade) => (
            <li key={trade.id}>
              <p>
                {trade.symbol} · {trade.direction} · {trade.positionSizeShares} shares · entry ₹{trade.entry.toFixed(2)}
              </p>
              <span>{trade.id} · {formatDateTime(trade.approvedAt)} · {trade.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
