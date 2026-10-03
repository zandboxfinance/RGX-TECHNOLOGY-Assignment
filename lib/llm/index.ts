import type { SummaryProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createFailingProvider, createMockProvider, type SimulatedFailure } from "./mock";

/**
 * Which LLM a run uses, chosen by the user in the UI:
 *   gemini – their own API key, sent per request in the X-Gemini-Key header (never in the URL)
 *   demo   – the templated mock, clearly labeled as not AI-generated, for trying the app without a key
 */
export type LlmConfig =
  | { mode: "demo" }
  | { mode: "gemini"; apiKey: string }
  // failure demo: a scripted Gemini error, so the error UI can be seen without spending quota
  | { mode: "simulate"; failure: SimulatedFailure };
export type CreateProvider = (cfg: LlmConfig) => SummaryProvider;

export const createProvider: CreateProvider = (cfg) =>
  cfg.mode === "demo"
    ? createMockProvider()
    : cfg.mode === "simulate"
      ? createFailingProvider(cfg.failure)
      : createGeminiProvider(cfg.apiKey);

const SIMULATIONS: SimulatedFailure[] = ["overloaded", "overloaded_midstream"];

export function llmConfigFrom(headers: Headers): LlmConfig | null {
  const sim = headers.get("x-llm-simulate") as SimulatedFailure | null;
  // a simulation never calls Gemini, but still requires the user to have chosen an LLM first
  const chosen = headers.get("x-llm-mode") === "demo" || !!headers.get("x-gemini-key")?.trim();
  if (sim && SIMULATIONS.includes(sim) && chosen) return { mode: "simulate", failure: sim };
  if (headers.get("x-llm-mode") === "demo") return { mode: "demo" };
  const apiKey = headers.get("x-gemini-key")?.trim();
  return apiKey ? { mode: "gemini", apiKey } : null;
}
