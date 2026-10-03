import type { Agent, AgentOutput, AgentResult } from "@/lib/types";

/**
 * Runs all agents concurrently. Each agent gets its own timeout, and a failure in one agent
 * becomes an `error` result instead of failing the whole request. `onResult` fires in
 * completion order, so the client sees the fastest block first.
 */
export async function runAgents(
  agents: Agent[],
  ctx: { symbol: string; signal: AbortSignal },
  onResult: (r: AgentResult) => void,
  timeoutMs = 12_000, // > fetcher's 2 attempts × 5s, so a retry can finish
  t0 = Date.now(), // reference point for `startMs`
): Promise<AgentResult[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const started = Date.now();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      let output: AgentOutput & { error?: string };
      try {
        output = await abortable(agent.run({ symbol: ctx.symbol, signal }), signal);
      } catch (err) {
        output = { status: "error", fields: [], missing: [], asOf: null, error: describe(err, timeoutMs) };
      }
      const { fetch, ...rest } = output;
      const result: AgentResult = {
        agent: agent.name,
        ...rest,
        startMs: started - t0,
        latencyMs: Date.now() - started,
        ...(fetch && {
          fetch: { origin: fetch.origin, startMs: fetch.startedAt - t0, endMs: fetch.endedAt - t0, attempts: fetch.attempts },
        }),
      };
      onResult(result);
      return result;
    }),
  );
}

/** Enforces the timeout even for agents that ignore their signal. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });
}

function describe(err: unknown, timeoutMs: number): string {
  if (err instanceof DOMException && err.name === "TimeoutError") return `agent timed out after ${timeoutMs / 1000}s`;
  if (err instanceof Error) return err.message;
  return String(err);
}
