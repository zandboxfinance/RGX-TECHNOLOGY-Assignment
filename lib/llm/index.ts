import type { SummaryProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createMockProvider } from "./mock";

export function createSummaryProvider(env = process.env): SummaryProvider {
  return env.GEMINI_API_KEY
    ? createGeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL || undefined)
    : createMockProvider();
}
