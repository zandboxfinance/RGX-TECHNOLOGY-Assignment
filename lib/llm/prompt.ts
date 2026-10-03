import type { AgentResult } from "@/lib/types";
import type { SummaryInput } from "./types";

export function systemPrompt(lang: SummaryInput["lang"]): string {
  const language = lang === "zh-TW" ? "Traditional Chinese (zh-TW, Taiwan financial terms)" : "English";
  return [
    "You are a sell-side analyst writing a quick stock snapshot for a retail investor.",
    `Write in ${language}.`,
    "Use ONLY the numbers provided. Never invent, estimate or recall figures from memory.",
    "If a block is marked unavailable, say that part of the data is missing instead of guessing.",
    "Format: 3 short bullet points (price action, valuation, financial health / risk), then one",
    "single-sentence takeaway. Under 120 words (or 200 characters in Chinese). No investment advice.",
  ].join("\n");
}

export function userPrompt(input: SummaryInput): string {
  const blocks = input.results.map(formatResult).join("\n\n");
  return `Stock: ${input.symbol} (Taiwan). Data as of trading day ${input.asOf ?? "unknown"}.\n\n${blocks}`;
}

function formatResult(r: AgentResult): string {
  const title = `## ${r.agent}`;
  if (r.status === "error") return `${title}\n(unavailable: ${r.error})`;
  const lines = r.fields.map((f) => `- ${f.label}: ${f.value === null ? "n/a" : `${f.value}${f.unit ? ` ${f.unit}` : ""}`}`);
  return [title, ...lines].join("\n");
}
