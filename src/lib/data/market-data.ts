import "server-only";

import { z } from "zod";
import { loadServerConfig, MARKET_DATA_DEFAULTS } from "@/lib/config";
import {
  MarketSnapshotSchema,
  type MarketSnapshot,
  type OhlcBar,
  type StructuredError,
} from "@/lib/contracts";
import marketNormalFixture from "@/fixtures/market_normal.json";

// The single market data adapter. Agents call getMarketSnapshot and never talk
// to a provider directly. It never throws, validates everything it receives,
// and never labels data as real time.

export const MARKET_DATA_ERROR_CODES = [
  "INVALID_SYMBOL",
  "TIMEOUT",
  "RATE_LIMIT",
  "PROVIDER_ERROR",
  "INVALID_OUTPUT",
  "INSUFFICIENT_DATA",
] as const;
export type MarketDataErrorCode = (typeof MARKET_DATA_ERROR_CODES)[number];

export type MarketDataResult =
  | {
      ok: true;
      snapshot: MarketSnapshot;
      // Set when a labelled fixture replaced a failed provider call, so the
      // trace can record why the fallback happened.
      fallbackReason?: StructuredError;
    }
  | { ok: false; error: StructuredError };

export type MarketDataOptions = {
  timeoutMs?: number;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Provider: Yahoo Finance public chart endpoint.
// This is an unofficial, undocumented endpoint with no SLA and no key. NSE data
// through it is delayed, so the adapter reports "delayed" and never "real_time".
// Check current terms of use before relying on it beyond this course project.
// Everything provider specific lives in this section so it can be swapped.
// ---------------------------------------------------------------------------

const nullableNumbers = z.array(z.number().nullable());

const YahooChartSchema = z.looseObject({
  chart: z.looseObject({
    result: z
      .array(
        z.looseObject({
          meta: z.looseObject({
            symbol: z.string().min(1),
            currency: z.string().min(1),
            regularMarketPrice: z.number().positive(),
            gmtoffset: z.number().int(),
          }),
          timestamp: z.array(z.number()),
          indicators: z.looseObject({
            quote: z
              .array(
                z.looseObject({
                  open: nullableNumbers,
                  high: nullableNumbers,
                  low: nullableNumbers,
                  close: nullableNumbers,
                  volume: nullableNumbers,
                }),
              )
              .min(1),
          }),
        }),
      )
      .min(1),
  }),
});

class ProviderFailure extends Error {
  constructor(
    readonly code: MarketDataErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

function isAbort(err: unknown): boolean {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}

async function fetchYahooDaily(symbol: string, signal: AbortSignal): Promise<unknown> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${MARKET_DATA_DEFAULTS.range}&interval=1d`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Okane paper trading research)" },
    });
  } catch (err) {
    if (isAbort(err)) throw new ProviderFailure("TIMEOUT", "Market data request timed out", true);
    throw new ProviderFailure("PROVIDER_ERROR", "Market data request failed", true);
  }
  if (response.status === 429) {
    throw new ProviderFailure("RATE_LIMIT", "Market data provider rate limit hit", false);
  }
  if (!response.ok) {
    throw new ProviderFailure(
      "PROVIDER_ERROR",
      `Market data provider returned status ${response.status}`,
      response.status >= 500,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (err) {
    if (isAbort(err)) throw new ProviderFailure("TIMEOUT", "Market data request timed out", true);
    throw new ProviderFailure("INVALID_OUTPUT", "Market data response was not valid JSON", false);
  }
}

type ProviderData = {
  symbol: string;
  currency: string;
  quotePrice: number;
  bars: OhlcBar[];
};

function normalizeYahoo(raw: unknown): ProviderData {
  const parsed = YahooChartSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderFailure("INVALID_OUTPUT", "Market data response did not match the expected shape", false);
  }
  const result = parsed.data.chart.result[0];
  const quote = result.indicators.quote[0];
  const offsetSeconds = result.meta.gmtoffset;
  const bars: OhlcBar[] = [];
  result.timestamp.forEach((time, i) => {
    const open = quote.open[i];
    const high = quote.high[i];
    const low = quote.low[i];
    const close = quote.close[i];
    const volume = quote.volume[i];
    // The provider reports null for sessions without a trade. Skip those rows.
    if (open == null || high == null || low == null || close == null || volume == null) return;
    bars.push({
      date: new Date((time + offsetSeconds) * 1000).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: Math.round(volume),
    });
  });
  return {
    symbol: result.meta.symbol,
    currency: result.meta.currency,
    quotePrice: result.meta.regularMarketPrice,
    bars,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,20}(\.NS)?$/;
const DAY_MS = 86_400_000;
const PROVIDER_NAME = "Yahoo Finance chart endpoint (unofficial, delayed)";

type CacheEntry = { snapshot: MarketSnapshot; storedAtMs: number };
const cache = new Map<string, CacheEntry>();

// Test helper. Also useful when a caller wants to force a fresh provider call.
export function clearMarketDataCache(): void {
  cache.clear();
}

function toError(code: MarketDataErrorCode, message: string): StructuredError {
  return { code, message };
}

function normalizeSymbol(input: string): string | undefined {
  const upper = input.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(upper)) return undefined;
  return upper.endsWith(".NS") ? upper : `${upper}.NS`;
}

function assessQuality(bars: OhlcBar[], now: Date): MarketSnapshot["dataQuality"] {
  const latest = bars.at(-1);
  if (latest === undefined || bars.length < MARKET_DATA_DEFAULTS.minBars) return "INSUFFICIENT";
  const ageDays = (now.getTime() - Date.parse(`${latest.date}T00:00:00.000Z`)) / DAY_MS;
  const stale = ageDays > MARKET_DATA_DEFAULTS.maxStaleDays;
  return bars.length >= MARKET_DATA_DEFAULTS.goodBars && !stale ? "GOOD" : "DEGRADED";
}

async function attemptProvider(
  symbol: string,
  timeoutMs: number,
  now: () => Date,
): Promise<MarketSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await fetchYahooDaily(symbol, controller.signal);
    const data = normalizeYahoo(raw);
    if (data.symbol.toUpperCase() !== symbol) {
      throw new ProviderFailure("INVALID_OUTPUT", "Market data response was for a different symbol", false);
    }
    if (data.bars.length < MARKET_DATA_DEFAULTS.minBars) {
      throw new ProviderFailure(
        "INSUFFICIENT_DATA",
        `Only ${data.bars.length} daily bars available, need at least ${MARKET_DATA_DEFAULTS.minBars}`,
        false,
      );
    }
    const current = now();
    const snapshot = MarketSnapshotSchema.safeParse({
      symbol,
      exchange: "NSE",
      currency: data.currency,
      bars: data.bars,
      quotePrice: data.quotePrice,
      source: PROVIDER_NAME,
      retrievedAt: current.toISOString(),
      dataMode: "provider",
      dataQuality: assessQuality(data.bars, current),
      freshness: "delayed",
      fromCache: false,
    });
    if (!snapshot.success) {
      throw new ProviderFailure("INVALID_OUTPUT", "Normalized market snapshot failed validation", false);
    }
    return snapshot.data;
  } finally {
    clearTimeout(timer);
  }
}

function toStructured(err: unknown): StructuredError {
  if (err instanceof ProviderFailure) return toError(err.code, err.message);
  return toError("PROVIDER_ERROR", "Unexpected market data failure");
}

// Fixtures replace a failed provider call only in demo mode, and only when the
// fixture is for the requested symbol. Real insufficiency is never masked.
function fixtureFallback(symbol: string): MarketSnapshot | undefined {
  const config = loadServerConfig();
  if (!config.ok || !config.config.demoMode) return undefined;
  const parsed = MarketSnapshotSchema.safeParse(marketNormalFixture);
  if (!parsed.success || parsed.data.symbol !== symbol) return undefined;
  return parsed.data;
}

// Never throws. Callers branch on `ok`.
export async function getMarketSnapshot(
  symbolInput: string,
  options: MarketDataOptions = {},
): Promise<MarketDataResult> {
  try {
    const symbol = normalizeSymbol(symbolInput);
    if (symbol === undefined) {
      return {
        ok: false,
        error: toError("INVALID_SYMBOL", "Symbol must be an NSE ticker such as RELIANCE.NS"),
      };
    }
    const now = options.now ?? (() => new Date());
    const timeoutMs = options.timeoutMs ?? MARKET_DATA_DEFAULTS.timeoutMs;

    const cached = cache.get(symbol);
    if (cached !== undefined) {
      if (now().getTime() - cached.storedAtMs < MARKET_DATA_DEFAULTS.cacheTtlMs) {
        return { ok: true, snapshot: { ...cached.snapshot, fromCache: true } };
      }
      cache.delete(symbol);
    }

    let failure: StructuredError | undefined;
    // One retry, only for timeouts and 5xx or network failures. A GET is safe to repeat.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await attemptProvider(symbol, timeoutMs, now);
        cache.set(symbol, { snapshot, storedAtMs: now().getTime() });
        return { ok: true, snapshot };
      } catch (err) {
        failure = toStructured(err);
        if (!(err instanceof ProviderFailure && err.retryable)) break;
      }
    }

    const error = failure ?? toError("PROVIDER_ERROR", "Market data unavailable");
    if (error.code !== "INSUFFICIENT_DATA") {
      const fixture = fixtureFallback(symbol);
      if (fixture !== undefined) return { ok: true, snapshot: fixture, fallbackReason: error };
    }
    return { ok: false, error };
  } catch {
    return { ok: false, error: toError("PROVIDER_ERROR", "Unexpected market data failure") };
  }
}
