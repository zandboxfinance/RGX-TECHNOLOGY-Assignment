import { createPageFetcher } from "@/lib/fetcher";
import { createAgents } from "@/lib/agents";
import { createSummaryProvider } from "@/lib/llm";
import { StreamStore } from "@/lib/streamStore";
import type { HandlerDeps } from "@/lib/overviewHandler";

// Only the stream store lives on globalThis, so in-flight streams survive `next dev` hot reloads.
// Agents and the provider are rebuilt per module load so code edits take effect without a restart.
const g = globalThis as unknown as { __overviewStore?: StreamStore };
const store = (g.__overviewStore ??= new StreamStore());

const deps: HandlerDeps = {
  store,
  agents: createAgents(createPageFetcher()),
  provider: createSummaryProvider(),
};

export function getDeps(): HandlerDeps {
  return deps;
}
