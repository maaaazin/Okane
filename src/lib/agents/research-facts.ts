import "server-only";

import type { MarketSnapshot } from "@/lib/contracts";

// Plain code facts for the Research Agent. These numbers are the only facts the
// model may use, so every figure is computed here and nothing is estimated.

const CHANGE_WINDOWS = [1, 5, 10] as const;

export type WindowChange = { sessions: number; percent: number };

export type ResearchFacts = {
  symbol: string;
  currency: string;
  latestPrice: number;
  latestBarDate: string;
  rangeStartDate: string;
  barCount: number;
  changes: WindowChange[];
  rangeHigh: number;
  rangeLow: number;
  averageVolume: number;
  distanceFromHighPercent: number;
};

// Returns undefined when the snapshot has no bars to compute from.
export function computeFacts(snapshot: MarketSnapshot): ResearchFacts | undefined {
  const { bars } = snapshot;
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined) return undefined;

  const latestPrice = snapshot.quotePrice;
  const changes: WindowChange[] = [];
  for (const sessions of CHANGE_WINDOWS) {
    const base = bars[bars.length - 1 - sessions];
    if (base !== undefined) {
      changes.push({ sessions, percent: (latestPrice / base.close - 1) * 100 });
    }
  }
  const rangeHigh = Math.max(...bars.map((bar) => bar.high));
  const rangeLow = Math.min(...bars.map((bar) => bar.low));
  const averageVolume = Math.round(
    bars.reduce((sum, bar) => sum + bar.volume, 0) / bars.length,
  );
  return {
    symbol: snapshot.symbol,
    currency: snapshot.currency,
    latestPrice,
    latestBarDate: last.date,
    rangeStartDate: first.date,
    barCount: bars.length,
    changes,
    rangeHigh,
    rangeLow,
    averageVolume,
    distanceFromHighPercent: ((rangeHigh - latestPrice) / rangeHigh) * 100,
  };
}

// The labelled data block that goes into the prompt, one fact per line.
export function formatFactsBlock(facts: ResearchFacts): string {
  const lines = [
    `SYMBOL: ${facts.symbol}`,
    `CURRENCY: ${facts.currency}`,
    `LATEST_PRICE: ${facts.latestPrice.toFixed(2)}`,
    `LATEST_BAR_DATE: ${facts.latestBarDate}`,
    `RANGE_START_DATE: ${facts.rangeStartDate}`,
    `DAILY_BARS_IN_RANGE: ${facts.barCount}`,
    ...facts.changes.map(
      (change) => `CHANGE_OVER_${change.sessions}_SESSIONS_PERCENT: ${change.percent.toFixed(2)}`,
    ),
    `RANGE_HIGH: ${facts.rangeHigh.toFixed(2)}`,
    `RANGE_LOW: ${facts.rangeLow.toFixed(2)}`,
    `AVERAGE_DAILY_VOLUME: ${facts.averageVolume}`,
    `DISTANCE_BELOW_RANGE_HIGH_PERCENT: ${facts.distanceFromHighPercent.toFixed(2)}`,
  ];
  return lines.join("\n");
}

// Every number and date a summary may legitimately mention.
export function allowedFigures(facts: ResearchFacts): { numbers: number[]; dates: string[] } {
  return {
    numbers: [
      facts.latestPrice,
      facts.barCount,
      facts.rangeHigh,
      facts.rangeLow,
      facts.averageVolume,
      Math.abs(facts.distanceFromHighPercent),
      ...facts.changes.flatMap((change) => [change.sessions, Math.abs(change.percent)]),
    ],
    dates: [facts.latestBarDate, facts.rangeStartDate],
  };
}
