import "server-only";

import { ChatAnthropic } from "@langchain/anthropic";
import { loadServerConfig, MODEL_DEFAULTS } from "@/lib/config";
import type { StructuredError } from "@/lib/contracts";

// The only place that builds the Claude client. The SDK reads
// ANTHROPIC_API_KEY from the server environment itself, so the key is never
// passed through application code.

export type ModelSource = "claude" | "mock";

export const MOCK_MODEL_LABEL = "MOCK_MODEL_DEMO_ONLY";

export type ModelClient = {
  source: ModelSource;
  invoke: (prompt: string, signal: AbortSignal) => Promise<string>;
};

export type ModelClientResult =
  | { ok: true; client: ModelClient }
  | { ok: false; error: StructuredError };

// Deterministic: the same prompt and the same canned response always give the
// same text. No randomness, no clock, no network.
export function createMockModel(mockResponse?: unknown): ModelClient {
  return {
    source: "mock",
    invoke: async (prompt) =>
      JSON.stringify(
        mockResponse ?? { label: MOCK_MODEL_LABEL, promptLength: prompt.length },
      ),
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null && "text" in block) {
          const text = (block as { text: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function createClaudeModel(): ModelClient {
  const chat = new ChatAnthropic({
    model: MODEL_DEFAULTS.modelName,
    temperature: MODEL_DEFAULTS.temperature,
    maxTokens: MODEL_DEFAULTS.maxTokens,
    maxRetries: 0,
    clientOptions: { timeout: MODEL_DEFAULTS.timeoutMs },
  });
  return {
    source: "claude",
    invoke: async (prompt, signal) => {
      const message = await chat.invoke(prompt, { signal });
      return textFromContent(message.content);
    },
  };
}

// Demo mode always gets the mock. Without demo mode a missing key is an error,
// because ARCHITECTURE.md allows labelled demo data only in demo mode and
// forbids inventing output otherwise.
export function createModel(mockResponse?: unknown): ModelClientResult {
  const loaded = loadServerConfig();
  if (!loaded.ok) return loaded;
  if (loaded.config.demoMode) {
    return { ok: true, client: createMockModel(mockResponse) };
  }
  if (loaded.config.keyStatus === "missing") {
    return {
      ok: false,
      error: {
        code: "MISSING_API_KEY",
        message: "ANTHROPIC_API_KEY is not set and demo mode is off",
      },
    };
  }
  return { ok: true, client: createClaudeModel() };
}
