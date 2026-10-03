import { describe, expect, it } from "vitest";
import { runAgents } from "@/lib/orchestrator";
import type { Agent, AgentName, AgentOutput } from "@/lib/types";
import { fixtureFetch, sleep } from "./helpers";
import { createAgents } from "@/lib/agents";
import { createPageFetcher } from "@/lib/fetcher";

function fakeAgent(name: AgentName, ms: number, fail?: string): Agent {
  return {
    name,
    async run(): Promise<AgentOutput> {
      await sleep(ms);
      if (fail) throw new Error(fail);
      return { status: "ok", fields: [], missing: [], asOf: null };
    },
  };
}

const ctx = () => ({ symbol: "2330", signal: new AbortController().signal });

describe("runAgents", () => {
  it("runs agents concurrently, not sequentially", async () => {
    const agents = [fakeAgent("price", 300), fakeAgent("valuation", 300), fakeAgent("financial", 300)];
    const t0 = Date.now();
    await runAgents(agents, ctx(), () => {});
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // sequential would be ~900ms
  });

  it("reports results in completion order", async () => {
    const order: string[] = [];
    await runAgents(
      [fakeAgent("price", 150), fakeAgent("valuation", 10), fakeAgent("financial", 80)],
      ctx(),
      (r) => order.push(r.agent),
    );
    expect(order).toEqual(["valuation", "financial", "price"]);
  });

  it("isolates failures and timeouts per agent", async () => {
    const results = await runAgents(
      [fakeAgent("price", 10), fakeAgent("valuation", 10, "boom"), fakeAgent("financial", 5_000)],
      ctx(),
      () => {},
      200,
    );
    expect(results.map((r) => r.status)).toEqual(["ok", "error", "error"]);
    expect(results[1].error).toBe("boom");
    expect(results[2].error).toBe("agent timed out after 0.2s");
  });

  it("real agents all start before any of them finishes", async () => {
    // each agent has its own fetcher, so nothing is shared or cached between them
    const agents = [0, 1, 2].map((i) => createAgents(createPageFetcher({ fetchImpl: fixtureFetch(200).impl }))[i]);
    const results = await runAgents(agents, ctx(), () => {});
    const firstEnd = Math.min(...results.map((r) => r.startMs + r.latencyMs));
    for (const r of results) {
      expect(r.status).toBe("ok");
      expect(r.startMs).toBeLessThan(firstEnd);
    }
    // sequential would be ~600ms
    expect(Math.max(...results.map((r) => r.startMs + r.latencyMs))).toBeLessThan(400);
  });
});
