import "server-only";

import { z } from "zod";
import type { StructuredError } from "@/lib/contracts";

// Validated server configuration. This is the only module that reads the
// Anthropic key from the environment. It never returns the key, never logs it,
// and never throws at import time.

export const MODEL_DEFAULTS = {
  modelName: "claude-sonnet-5-5",
  temperature: 0,
  timeoutMs: 30_000,
  maxTokens: 2048,
} as const;

export const MARKET_DATA_DEFAULTS = {
  // Per attempt timeout for the provider call.
  timeoutMs: 8_000,
  // In memory cache lifetime per symbol.
  cacheTtlMs: 5 * 60_000,
  // Daily bars requested from the provider.
  range: "1mo",
  // Below this many bars the data is unusable and the adapter returns INSUFFICIENT_DATA.
  minBars: 10,
  // At or above this many bars, and not stale, quality is GOOD.
  goodBars: 15,
  // Latest bar older than this many calendar days downgrades quality to DEGRADED.
  maxStaleDays: 5,
} as const;

export const EVALUATOR_DEFAULTS = {
  maxScore: 100,
  passThreshold: 70,
  maxTotalMs: 15000,
  maxAgentMs: 5000,
  penalties: {
    MISSING_CITATION: 20,
    UNSUPPORTED_CLAIM: 20,
    STALE_DATA: 10,
    OVERCONFIDENT: 15,
    THIN_EVIDENCE: 40,
    SLOW_RUN: 5,
  },
  maxRevisionCount: 1,
} as const;

const API_KEY_VAR = "ANTHROPIC_API_KEY";
// Existing flag from .env.example. It is a plain boolean, not a secret.
const DEMO_MODE_VAR = "NEXT_PUBLIC_DEMO_MODE";

const EnvSchema = z.object({
  [API_KEY_VAR]: z.string().trim().min(1).optional(),
  [DEMO_MODE_VAR]: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export type ServerConfig = {
  demoMode: boolean;
  keyStatus: "present" | "missing";
};

export type ServerConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; error: StructuredError };

// An empty string counts as missing, so a blank `ANTHROPIC_API_KEY=` line
// in .env.local behaves like an unset variable.
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    [API_KEY_VAR]: env[API_KEY_VAR] === "" ? undefined : env[API_KEY_VAR],
    [DEMO_MODE_VAR]: env[DEMO_MODE_VAR] === "" ? undefined : env[DEMO_MODE_VAR],
  };
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfigResult {
  const parsed = EnvSchema.safeParse(normalizeEnv(env));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message: `Invalid server configuration for: ${names.join(", ")}`,
      },
    };
  }
  return {
    ok: true,
    config: {
      demoMode: parsed.data[DEMO_MODE_VAR],
      keyStatus: parsed.data[API_KEY_VAR] === undefined ? "missing" : "present",
    },
  };
}

const KEY_SHAPED = /sk-ant-[A-Za-z0-9_-]+/g;

// Removes the configured key and anything shaped like an Anthropic key.
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(KEY_SHAPED, "[REDACTED]");
  const key = env[API_KEY_VAR];
  if (key !== undefined && key.length > 0) {
    out = out.split(key).join("[REDACTED]");
  }
  return out;
}
