import { describe, expect, it, vi } from "vitest";
import { handleOverview } from "@/lib/overviewHandler";
import { llmConfigFrom, type LlmConfig } from "@/lib/llm";
import { classifyLlmError, LlmError } from "@/lib/llm/errors";
import { createFailingProvider, createMockProvider } from "@/lib/llm/mock";
import type { SummaryProvider } from "@/lib/llm/types";
import { StreamStore } from "@/lib/streamStore";
import type { Agent } from "@/lib/types";
import { createSseParser, type SseMessage } from "@/lib/sse";

const KEY = "AIzaTEST-key-that-must-never-leak-1234";

function setup(provider: (cfg: LlmConfig) => SummaryProvider = () => createMockProvider(0)) {
  const agentRuns = vi.fn();
  const agent: Agent = {
    name: "price",
    run: async () => {
      agentRuns();
      return { status: "ok", fields: [{ key: "close", label: "Close", labelZh: "收盤價", value: 1, unit: "TWD" }], missing: [], asOf: "10/02" };
    },
  };
  const createProvider = vi.fn(provider);
  const store = new StreamStore({ abandonAfterMs: 1_000, retainAfterDoneMs: 1_000 });
  return { deps: { store, agents: [agent], createProvider }, agentRuns, createProvider, store };
}

async function readAll(res: Response): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  const parse = createSseParser((m) => out.push(m));
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    parse(value);
  }
}

const get = (headers: Record<string, string>) => new Request("http://test/api/overview?symbol=2330", { headers });

describe("LLM selection per request", () => {
  it("rejects a new run without a key or demo mode, before any agent runs", async () => {
    const { deps, agentRuns, store } = setup();
    const res = await handleOverview(get({}), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing_api_key" });
    expect(agentRuns).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("passes the user's key from the header to the provider, never via the URL", async () => {
    const { deps, createProvider } = setup();
    await readAll(await handleOverview(get({ "X-Gemini-Key": ` ${KEY} ` }), deps));
    expect(createProvider).toHaveBeenCalledWith({ mode: "gemini", apiKey: KEY });
  });

  it("runs demo mode without any key", async () => {
    const { deps, createProvider } = setup();
    const msgs = await readAll(await handleOverview(get({ "X-LLM-Mode": "demo" }), deps));
    expect(createProvider).toHaveBeenCalledWith({ mode: "demo" });
    expect(msgs.at(-1)!.event).toBe("done");
  });

  it("reads headers case-insensitively and ignores a blank key", () => {
    expect(llmConfigFrom(new Headers({ "x-gemini-key": KEY }))).toEqual({ mode: "gemini", apiKey: KEY });
    expect(llmConfigFrom(new Headers({ "X-Gemini-Key": "   " }))).toBeNull();
  });

  it("streams a coded error the UI can act on, without leaking the key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: SummaryProvider = {
      name: "gemini:test",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw Object.assign(new Error(`API key not valid. key=${KEY}`), { status: 400 });
      },
    };
    const { deps } = setup(() => failing);
    const msgs = await readAll(await handleOverview(get({ "X-Gemini-Key": KEY }), deps));
    const err = msgs.find((m) => m.event === "error")!;
    expect(JSON.parse(err.data)).toMatchObject({ message: "invalid API key", code: "invalid_key", retryable: false, partial: false });
    expect(JSON.stringify(msgs)).not.toContain(KEY);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY);
    errors.mockRestore();
  });
});

describe("classifyLlmError", () => {
  it.each([
    [{ status: 400, message: "API key not valid. Please pass a valid API key." }, "invalid_key"],
    [{ status: 403, message: "PERMISSION_DENIED" }, "invalid_key"],
    [{ status: 429, message: "RESOURCE_EXHAUSTED" }, "quota"],
    [{ status: 503, message: "This model is currently experiencing high demand. Please try again later." }, "overloaded"],
    [{ status: undefined, message: "got status: UNAVAILABLE. The model is overloaded." }, "overloaded"],
    [{ status: 500, message: "internal" }, "llm_error"],
    [{ status: 404, message: "models/gemini-3.1-flash-lite is not found" }, "llm_error"],
  ])("%o → %s", (e, code) => {
    expect(classifyLlmError(Object.assign(new Error(e.message), { status: e.status })).code).toBe(code);
  });

  it("redacts anything shaped like a key from pass-through messages", () => {
    const e = classifyLlmError(Object.assign(new Error(`upstream said: bad request for ${KEY}`), { status: 500 }));
    expect(e.code).toBe("llm_error");
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("[redacted]");
  });

  it("says which model is missing when the key can't use it", () => {
    const e = classifyLlmError(Object.assign(new Error("NOT_FOUND"), { status: 404 }));
    expect(e.message).toBe("model gemini-3.1-flash-lite is not available for this key");
  });

  it("marks everything but an invalid key as retryable", () => {
    expect(new LlmError("x", "invalid_key").retryable).toBe(false);
    for (const code of ["quota", "overloaded", "llm_error"] as const) expect(new LlmError("x", code).retryable).toBe(true);
  });

  it("passes an LlmError through unchanged", () => {
    const e = new LlmError("x", "quota");
    expect(classifyLlmError(e)).toBe(e);
  });
});

describe("Gemini failures reach the client with what the UI needs", () => {
  const errorOf = (msgs: SseMessage[]) => JSON.parse(msgs.find((m) => m.event === "error")!.data);

  it("a failure before any text: coded, timed, retryable, not partial", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = setup(() => createFailingProvider("overloaded", 0));
    const msgs = await readAll(await handleOverview(get({ "X-LLM-Mode": "demo", "X-LLM-Simulate": "overloaded" }), deps));
    const err = errorOf(msgs);
    expect(err).toMatchObject({ code: "overloaded", partial: false, retryable: true, simulated: true });
    expect(err.atMs).toBeGreaterThanOrEqual(700); // after the simulated wait for a response
    expect(msgs.some((m) => m.event === "token")).toBe(false);
    expect(msgs.some((m) => m.event === "done")).toBe(false);
    errors.mockRestore();
  });

  it("a failure mid-stream keeps the text already sent and flags it as partial", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = setup(() => createFailingProvider("overloaded_midstream", 0));
    const msgs = await readAll(await handleOverview(get({ "X-LLM-Mode": "demo", "X-LLM-Simulate": "overloaded_midstream" }), deps));
    expect(msgs.filter((m) => m.event === "token")).toHaveLength(12);
    expect(errorOf(msgs)).toMatchObject({ code: "overloaded", partial: true, retryable: true });
    expect(msgs.at(-1)!.event).toBe("error");
    errors.mockRestore();
  });

  it("a simulation still requires the user to have chosen an LLM", () => {
    expect(llmConfigFrom(new Headers({ "X-LLM-Simulate": "overloaded" }))).toBeNull();
    expect(llmConfigFrom(new Headers({ "X-LLM-Simulate": "overloaded", "X-Gemini-Key": KEY }))).toEqual({
      mode: "simulate",
      failure: "overloaded",
    });
    expect(llmConfigFrom(new Headers({ "X-LLM-Simulate": "bogus", "X-LLM-Mode": "demo" }))).toEqual({ mode: "demo" });
  });
});
