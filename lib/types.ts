import type { FetchOrigin } from "@/lib/fetcher";

export type AgentName = "price" | "valuation" | "financial";

/**
 * ok      – every expected field was found
 * partial – the page was parsed but some labels were missing (page layout drift)
 * error   – the agent could not produce anything (network, timeout, unparsable page)
 */
export type AgentStatus = "ok" | "partial" | "error";

export interface Field {
  key: string;
  label: string;
  labelZh: string;
  value: number | null;
  unit: string;
}

export interface AgentResult {
  agent: AgentName;
  status: AgentStatus;
  fields: Field[];
  missing: string[];
  /** Trading date shown on the page, e.g. "10/02". */
  asOf: string | null;
  error?: string;
  /** Offset from the start of the request, so the client can draw a timeline without clock skew. */
  startMs: number;
  latencyMs: number;
  /** How this agent got the page; times are offsets like `startMs` (negative for a cache hit). */
  fetch?: { origin: FetchOrigin; startMs: number; endMs: number; attempts: number };
}

/** What an agent itself produces; timing and identity are added by the orchestrator. */
export type AgentOutput = Pick<AgentResult, "status" | "fields" | "missing" | "asOf"> & {
  fetch?: { origin: FetchOrigin; startedAt: number; endedAt: number; attempts: number };
};

export type Lang = "zh-TW" | "en";

export interface AgentContext {
  symbol: string;
  signal: AbortSignal;
}

export type Agent = {
  name: AgentName;
  run: (ctx: AgentContext) => Promise<AgentOutput>;
};

/** Every event the server streams. `type` becomes the SSE `event:` field. */
export type OverviewEvent =
  | { type: "meta"; data: { streamId: string; symbol: string; lang: Lang; sourceUrl: string } }
  | { type: "agent_result"; data: AgentResult }
  | { type: "synthesis_start"; data: { provider: string; atMs: number } }
  | { type: "token"; data: { text: string } }
  | { type: "done"; data: { totalMs: number; firstTokenMs: number | null } }
  | { type: "error"; data: RunError };

/** A run that ended in failure. `atMs` is on the same clock as the other offsets, for the timeline. */
export interface RunError {
  message: string;
  code?: "invalid_key" | "quota" | "overloaded" | "llm_error" | "agents_failed";
  atMs?: number;
  /** Some summary text had already streamed before the failure, so what's on screen is incomplete. */
  partial?: boolean;
  /** Whether running the query again can help (false for an invalid key). */
  retryable?: boolean;
  /** The failure was produced by a failure demo, not by Gemini. */
  simulated?: boolean;
}
