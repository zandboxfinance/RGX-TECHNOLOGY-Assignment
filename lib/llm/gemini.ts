import { GoogleGenAI } from "@google/genai";
import type { SummaryProvider } from "./types";
import { systemPrompt, userPrompt } from "./prompt";
import { classifyLlmError } from "./errors";
import { GEMINI_MODEL } from "./model";

/** The key is the user's own, sent with their request; it lives only as long as this provider. */
export function createGeminiProvider(apiKey: string, model = GEMINI_MODEL): SummaryProvider {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: `gemini:${model}`,
    async *stream(input, signal) {
      try {
        const stream = await ai.models.generateContentStream({
          model,
          contents: userPrompt(input),
          config: {
            systemInstruction: systemPrompt(input.lang),
            temperature: 0.3,
            abortSignal: signal,
          },
        });
        for await (const chunk of stream) {
          if (signal.aborted) return;
          if (chunk.text) yield chunk.text;
        }
      } catch (err) {
        if (signal.aborted) return;
        throw classifyLlmError(err);
      }
    },
  };
}

/**
 * Cheap check before the first query: fetching the model's metadata costs no generation quota, and
 * fails both on a bad key and when this key can't use the pinned model.
 */
export async function verifyGeminiKey(apiKey: string, signal: AbortSignal): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  try {
    await ai.models.get({ model: GEMINI_MODEL, config: { abortSignal: signal } });
  } catch (err) {
    throw classifyLlmError(err);
  }
}
