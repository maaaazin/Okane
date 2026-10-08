import "server-only";

import type { z } from "zod";
import { MODEL_DEFAULTS, redactSecrets } from "@/lib/config";
import type { AgentName, StructuredError } from "@/lib/contracts";
import { createModel, type ModelSource } from "@/lib/model-factory";

export const MODEL_ERROR_CODES = [
  "MISSING_API_KEY",
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTH_FAILURE",
  "PROVIDER_ERROR",
  "INVALID_OUTPUT",
  "UNKNOWN",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export type SafeModelRequest<T> = {
  prompt: string;
  schema: z.ZodType<T>;
  agent?: AgentName;
  // Canned deterministic reply used only when the mock model is selected.
  mockResponse?: unknown;
};

export type SafeModelResult<T> =
  | { ok: true; output: T; source: ModelSource }
  | { ok: false; error: StructuredError; source: ModelSource | "none" };

function fail(
  code: string,
  message: string,
  source: ModelSource | "none",
  agent?: AgentName,
): { ok: false; error: StructuredError; source: ModelSource | "none" } {
  const safe = redactSecrets(message).trim() || "Model call failed";
  return {
    ok: false,
    source,
    error: agent === undefined ? { code, message: safe } : { code, message: safe, agent },
  };
}

function classify(err: unknown): { code: ModelErrorCode; message: string } {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const name = typeof e.name === "string" ? e.name : "";
  const raw = typeof e.message === "string" ? e.message : "";
  const status = typeof e.status === "number" ? e.status : undefined;

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "APIConnectionTimeoutError" ||
    status === 408 ||
    /timed? ?out/i.test(raw)
  ) {
    return { code: "TIMEOUT", message: "Model call timed out" };
  }
  if (status === 429) return { code: "RATE_LIMIT", message: "Model provider rate limit hit" };
  if (status === 401 || status === 403) {
    return { code: "AUTH_FAILURE", message: "Model provider rejected the credentials" };
  }
  if (status !== undefined && status >= 400) {
    return { code: "PROVIDER_ERROR", message: `Model provider returned status ${status}` };
  }
  return { code: "UNKNOWN", message: raw || "Unknown model failure" };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

// Never throws. Agents call this and branch on `ok`.
export async function invokeModelSafely<T>(
  request: SafeModelRequest<T>,
): Promise<SafeModelResult<T>> {
  const { agent } = request;
  let source: ModelSource | "none" = "none";
  try {
    const created = createModel(request.mockResponse);
    if (!created.ok) {
      return fail(created.error.code, created.error.message, "none", agent);
    }
    const { client } = created;
    source = client.source;

    const signal = AbortSignal.timeout(MODEL_DEFAULTS.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("Model call timed out"), { name: "TimeoutError" })),
        MODEL_DEFAULTS.timeoutMs,
      );
    });
    let text: string;
    try {
      text = await Promise.race([client.invoke(request.prompt, signal), deadline]);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = parseJson(text);
    } catch {
      return fail("INVALID_OUTPUT", "Model output was not valid JSON", source, agent);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      return fail("INVALID_OUTPUT", "Model output did not match the expected schema", source, agent);
    }
    return { ok: true, output: parsed.data, source };
  } catch (err) {
    const { code, message } = classify(err);
    return fail(code, message, source, agent);
  }
}
