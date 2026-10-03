import { createPageFetcher } from "@/lib/fetcher";
import { createAgents } from "@/lib/agents";
import { createProvider } from "@/lib/llm";
import { StreamStore } from "@/lib/streamStore";
import type { HandlerDeps } from "@/lib/overviewHandler";

// Only the stream store lives on globalThis, so in-flight streams survive `next dev` hot reloads.
// Agents are rebuilt per module load so code edits take effect without a restart. The LLM provider
// is created per run from the user's own key (see llmConfigFrom), so the server holds no key.
const g = globalThis as unknown as { __overviewStore?: StreamStore };
const store = (g.__overviewStore ??= new StreamStore());

const deps: HandlerDeps = {
  store,
  agents: createAgents(createPageFetcher()),
  createProvider,
};

export function getDeps(): HandlerDeps {
  return deps;
}
