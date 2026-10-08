import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { StructuredErrorSchema } from "@/lib/contracts";
import { invokeModelSafely } from "@/lib/safe-model";

// Written against node:test. Moving to Vitest means swapping the first two
// imports for `vitest`; the describe, it and assert calls stay the same.

const OutputSchema = z.object({ ok: z.boolean() }).strict();
const VARS = ["ANTHROPIC_API_KEY", "NEXT_PUBLIC_DEMO_MODE"] as const;

describe("invokeModelSafely with no API key", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("returns a structured MISSING_API_KEY error and does not throw when demo mode is off", async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "false";
    const result = await invokeModelSafely({ prompt: "hello", schema: OutputSchema });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "MISSING_API_KEY");
    assert.equal(result.source, "none");
    assert.equal(StructuredErrorSchema.safeParse(result.error).success, true);
  });

  it("returns the labelled deterministic mock when demo mode is on", async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    const request = { prompt: "hello", schema: OutputSchema, mockResponse: { ok: true } };
    const first = await invokeModelSafely(request);
    const second = await invokeModelSafely(request);
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    assert.equal(first.source, "mock");
  });
});
