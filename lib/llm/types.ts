import type { AgentResult, Lang } from "@/lib/types";

export interface SummaryInput {
  symbol: string;
  asOf: string | null;
  lang: Lang;
  results: AgentResult[];
}

export interface SummaryProvider {
  name: string;
  /** Set by the failure demo, so its errors are labeled as simulated. */
  simulated?: boolean;
  /** Yields text chunks as soon as they are generated. Must stop when `signal` aborts. */
  stream(input: SummaryInput, signal: AbortSignal): AsyncIterable<string>;
}
