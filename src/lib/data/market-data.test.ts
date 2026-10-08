import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MarketSnapshotSchema, StructuredErrorSchema } from "@/lib/contracts";
import { clearMarketDataCache, getMarketSnapshot } from "@/lib/data/market-data";

// Written against node:test, same style as safe-model.test.ts. No network is
// used: globalThis.fetch is replaced in every test.

const DEMO_VAR = "NEXT_PUBLIC_DEMO_MODE";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-08T10:00:00.000Z");
const realFetch = globalThis.fetch;

// Builds a provider shaped chart response with `count` daily bars ending on NOW.
function chartBody(count: number, symbol = "RELIANCE.NS"): unknown {
  const timestamp: number[] = [];
  const series: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = new Date(NOW.getTime() - (count - 1 - i) * DAY_MS);
    timestamp.push(Math.floor(day.getTime() / 1000));
    series.push(1200 + i);
  }
  return {
    chart: {
      result: [
        {
          meta: { symbol, currency: "INR", regularMarketPrice: 1178, gmtoffset: 19800 },
          timestamp,
          indicators: {
            quote: [
              {
                open: series,
                high: series.map((v) => v + 5),
                low: series.map((v) => v - 5),
                close: series,
                volume: series.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (signal: AbortSignal | undefined) => Promise<Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    state.calls += 1;
    return handler(init?.signal ?? undefined);
  }) as typeof fetch;
  return state;
}

// Rejects with an AbortError when the adapter aborts the request.
function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  });
}

describe("getMarketSnapshot", () => {
  let savedDemo: string | undefined;

  beforeEach(() => {
    savedDemo = process.env[DEMO_VAR];
    process.env[DEMO_VAR] = "false";
    clearMarketDataCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedDemo === undefined) delete process.env[DEMO_VAR];
    else process.env[DEMO_VAR] = savedDemo;
  });

  it("returns a validated delayed provider snapshot on success", async () => {
    mockFetch(async () => jsonResponse(chartBody(20)));
    const result = await getMarketSnapshot("reliance", { now: () => NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { snapshot } = result;
    assert.equal(MarketSnapshotSchema.safeParse(snapshot).success, true);
    assert.equal(snapshot.symbol, "RELIANCE.NS");
    assert.equal(snapshot.dataMode, "provider");
    assert.equal(snapshot.dataQuality, "GOOD");
    assert.equal(snapshot.freshness, "delayed");
    assert.equal(snapshot.fromCache, false);
    assert.equal(snapshot.retrievedAt, NOW.toISOString());
    assert.equal(snapshot.bars.length, 20);
  });

  it("returns a TIMEOUT error and does not throw when the provider hangs", async () => {
    const state = mockFetch(hangUntilAborted);
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW, timeoutMs: 20 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "TIMEOUT");
    assert.equal(StructuredErrorSchema.safeParse(result.error).success, true);
    // One bounded retry, never more.
    assert.equal(state.calls, 2);
  });

  it("returns RATE_LIMIT on HTTP 429 without retrying", async () => {
    const state = mockFetch(async () => jsonResponse({}, 429));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RATE_LIMIT");
    assert.equal(state.calls, 1);
  });

  it("returns PROVIDER_ERROR for a non 429 HTTP failure", async () => {
    mockFetch(async () => jsonResponse({}, 404));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "PROVIDER_ERROR");
  });

  it("returns INVALID_OUTPUT when the response fails validation", async () => {
    mockFetch(async () => jsonResponse({ chart: { result: [{ meta: {} }] } }));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INVALID_OUTPUT");
  });

  it("returns INSUFFICIENT_DATA when there are too few bars", async () => {
    mockFetch(async () => jsonResponse(chartBody(3)));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INSUFFICIENT_DATA");
  });

  it("marks usable but short history as DEGRADED, not GOOD", async () => {
    mockFetch(async () => jsonResponse(chartBody(12)));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.dataQuality, "DEGRADED");
  });

  it("rejects a malformed symbol without calling the provider", async () => {
    const state = mockFetch(async () => jsonResponse(chartBody(20)));
    const result = await getMarketSnapshot("../etc?x=1", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INVALID_SYMBOL");
    assert.equal(state.calls, 0);
  });

  it("falls back to the labelled fixture in demo mode when the provider fails", async () => {
    process.env[DEMO_VAR] = "true";
    mockFetch(async () => jsonResponse({}, 429));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.dataMode, "fixture");
    assert.equal(result.snapshot.freshness, "fixture");
    assert.ok(result.snapshot.demoLabel);
    assert.ok(result.snapshot.asOf);
    assert.equal(result.fallbackReason?.code, "RATE_LIMIT");
  });

  it("does not use the fixture in demo mode when the data is genuinely insufficient", async () => {
    process.env[DEMO_VAR] = "true";
    mockFetch(async () => jsonResponse(chartBody(3)));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INSUFFICIENT_DATA");
  });

  it("returns the structured error and no fixture outside demo mode", async () => {
    mockFetch(async () => jsonResponse({}, 429));
    const result = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RATE_LIMIT");
  });

  it("serves a cache hit with the original retrievedAt and source", async () => {
    const state = mockFetch(async () => jsonResponse(chartBody(20)));
    const first = await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    const later = new Date(NOW.getTime() + 30_000);
    const second = await getMarketSnapshot("RELIANCE.NS", { now: () => later });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(state.calls, 1);
    assert.equal(second.snapshot.fromCache, true);
    assert.equal(second.snapshot.retrievedAt, first.snapshot.retrievedAt);
    assert.equal(second.snapshot.source, first.snapshot.source);
  });

  it("refetches once the cache entry has expired", async () => {
    const state = mockFetch(async () => jsonResponse(chartBody(20)));
    await getMarketSnapshot("RELIANCE.NS", { now: () => NOW });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const second = await getMarketSnapshot("RELIANCE.NS", { now: () => later });
    assert.equal(state.calls, 2);
    assert.equal(second.ok && second.snapshot.fromCache, false);
  });
});

describe("MarketSnapshotSchema freshness", () => {
  const base = {
    symbol: "RELIANCE.NS",
    exchange: "NSE",
    currency: "INR",
    bars: [],
    quotePrice: 100,
    source: "test",
    retrievedAt: NOW.toISOString(),
    dataMode: "provider",
    dataQuality: "GOOD",
    fromCache: false,
  };

  it("rejects real_time without the explicit entitlement flag", () => {
    assert.equal(MarketSnapshotSchema.safeParse({ ...base, freshness: "real_time" }).success, false);
  });

  it("accepts real_time only with the explicit flag", () => {
    const parsed = MarketSnapshotSchema.safeParse({
      ...base,
      freshness: "real_time",
      realTimeEntitlementVerified: true,
    });
    assert.equal(parsed.success, true);
  });

  it("rejects a missing freshness value", () => {
    assert.equal(MarketSnapshotSchema.safeParse(base).success, false);
  });
});
