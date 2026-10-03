import type { Agent, AgentName, AgentOutput, Field } from "@/lib/types";
import type { FetchPage } from "@/lib/fetcher";
import { extractAsOf, extractLabelValues, normalizeLabel, parseNumber } from "@/lib/parse";

export interface FieldSpec {
  key: string;
  /** English display label (also what the LLM sees). */
  label: string;
  labelZh: string;
  /** Page labels to try, in order. Extra aliases absorb small wording changes on the page. */
  pageLabels: string[];
  unit: string;
}

export const pageUrl = (symbol: string) =>
  `https://fubon-ebrokerdj.fbs.com.tw/Z/ZC/ZCX/ZCX_${symbol}.djhtm`;

/**
 * Builds an agent that pulls one block of fields off the stock page.
 * Each agent fetches independently; the shared single-flight fetcher collapses them into one request.
 */
export function createScrapeAgent(name: AgentName, specs: FieldSpec[], fetchPage: FetchPage): Agent {
  return {
    name,
    async run({ symbol, signal }): Promise<AgentOutput> {
      const { body: html, ...fetch } = await fetchPage(pageUrl(symbol), signal);
      const cells = extractLabelValues(html);

      const fields: Field[] = specs.map((s) => {
        const raw = s.pageLabels.map((l) => cells.get(normalizeLabel(l))).find((v) => v !== undefined);
        return { key: s.key, label: s.label, labelZh: s.labelZh, value: parseNumber(raw), unit: s.unit };
      });
      const missing = fields.filter((f) => f.value === null).map((f) => f.key);

      if (missing.length === fields.length) {
        throw new Error(`none of the ${name} fields were found; page layout may have changed or symbol is invalid`);
      }
      return { status: missing.length ? "partial" : "ok", fields, missing, asOf: extractAsOf(html), fetch };
    },
  };
}
