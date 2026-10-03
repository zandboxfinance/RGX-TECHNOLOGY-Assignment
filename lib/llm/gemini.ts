import { GoogleGenAI } from "@google/genai";
import type { SummaryProvider } from "./types";
import { systemPrompt, userPrompt } from "./prompt";

export function createGeminiProvider(apiKey: string, model = "gemini-flash-latest"): SummaryProvider {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: `gemini:${model}`,
    async *stream(input, signal) {
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
    },
  };
}
