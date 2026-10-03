import type { Agent, Lang } from "@/lib/types";
import type { SummaryProvider } from "@/lib/llm/types";
import { classifyLlmError } from "@/lib/llm/errors";
import type { StreamSession } from "@/lib/streamStore";
import { runAgents } from "@/lib/orchestrator";
import { pageUrl } from "@/lib/agents/scrapeAgent";

export interface PipelineDeps {
  agents: Agent[];
  agentTimeoutMs?: number;
}

/**
 * agents (parallel) → synthesis (streamed). Everything is written to the session, never to a
 * socket, so the run is independent of whichever connection happens to be listening.
 */
export async function runPipeline(
  session: StreamSession,
  { symbol, lang, provider }: { symbol: string; lang: Lang; provider: SummaryProvider },
  deps: PipelineDeps,
): Promise<void> {
  const t0 = Date.now();
  const signal = session.signal;
  let firstTokenMs: number | null = null;

  try {
    session.append({ type: "meta", data: { streamId: session.id, symbol, lang, sourceUrl: pageUrl(symbol) } });

    const results = await runAgents(
      deps.agents,
      { symbol, signal },
      (r) => {
        if (r.status === "error") console.warn(`[agent:${r.agent}] ${symbol} failed after ${r.latencyMs}ms: ${r.error}`);
        session.append({ type: "agent_result", data: r });
      },
      deps.agentTimeoutMs,
      t0,
    );
    if (signal.aborted) return;
    if (results.every((r) => r.status === "error")) {
      session.append({
        type: "error",
        data: { message: `all agents failed (${results[0]?.error ?? "unknown"})`, code: "agents_failed", atMs: Date.now() - t0, retryable: true },
      });
      return;
    }

    session.append({ type: "synthesis_start", data: { provider: provider.name, atMs: Date.now() - t0 } });
    const asOf = results.find((r) => r.asOf)?.asOf ?? null;
    for await (const text of provider.stream({ symbol, asOf, lang, results }, signal)) {
      firstTokenMs ??= Date.now() - t0;
      session.append({ type: "token", data: { text } });
    }
    if (signal.aborted) return;

    session.append({ type: "done", data: { totalMs: Date.now() - t0, firstTokenMs } });
  } catch (err) {
    if (!signal.aborted) {
      const e = classifyLlmError(err);
      // log the code and message only: never the error object, which could carry request config
      console.error(`[synthesis] ${symbol} failed: ${e.code}: ${e.message}`);
      session.append({
        type: "error",
        data: {
          message: e.message,
          code: e.code,
          atMs: Date.now() - t0,
          partial: firstTokenMs !== null,
          retryable: e.retryable,
          ...(provider.simulated && { simulated: true }),
        },
      });
    }
  } finally {
    session.finish();
  }
}
