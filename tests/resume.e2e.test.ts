import { describe, expect, it } from "vitest";
import { handleOverview, type HandlerDeps } from "@/lib/overviewHandler";
import { createAgents } from "@/lib/agents";
import { createPageFetcher } from "@/lib/fetcher";
import { createMockProvider } from "@/lib/llm/mock";
import { StreamStore } from "@/lib/streamStore";
import { createSseParser, encodeSse, type SseMessage } from "@/lib/sse";
import { openResumableStream, type ConnectionState } from "@/lib/client/resumableStream";
import type { OverviewEvent } from "@/lib/types";
import { fixtureFetch, sleep } from "./helpers";

function makeDeps(opts: { abandonAfterMs?: number } = {}): HandlerDeps {
  return {
    store: new StreamStore({ abandonAfterMs: opts.abandonAfterMs ?? 1_000, retainAfterDoneMs: 1_000 }),
    agents: createAgents(createPageFetcher({ fetchImpl: fixtureFetch(20).impl })),
    provider: createMockProvider(2),
  };
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

const seq = (m: SseMessage) => Number(m.id!.split(":")[1]);
const tokens = (ms: SseMessage[]) => ms.filter((m) => m.event === "token").map((m) => JSON.parse(m.data).text).join("");
const req = (qs: string, headers: Record<string, string> = {}) =>
  new Request(`http://test/api/overview?${qs}`, { headers });

describe("GET /api/overview", () => {
  it("streams agent results, then the synthesis, then done", async () => {
    const msgs = await readAll(await handleOverview(req("symbol=2330&lang=en"), makeDeps()));
    const kinds = msgs.map((m) => m.event);
    expect(kinds[0]).toBe("meta");
    expect(kinds.slice(1, 4).sort()).toEqual(["agent_result", "agent_result", "agent_result"]);
    expect(kinds[4]).toBe("synthesis_start");
    expect(kinds.at(-1)).toBe("done");
    expect(tokens(msgs)).toContain("closed at 2,500");

    // single-flight is visible in the stream: one agent triggered the request, two joined it
    const fetches = msgs.filter((m) => m.event === "agent_result").map((m) => JSON.parse(m.data).fetch);
    expect(fetches.map((f) => f.origin).sort()).toEqual(["network", "shared", "shared"]);
    expect(new Set(fetches.map((f) => f.startMs)).size).toBe(1);
  });

  it("rejects bad symbols", async () => {
    const res = await handleOverview(req("symbol=../../etc"), makeDeps());
    expect(res.status).toBe(400);
  });

  it("resumes from Last-Event-ID with no gaps or duplicates", async () => {
    const deps = makeDeps();
    const first = await readAll(await handleOverview(req("symbol=2330&drop_after=7"), deps));
    expect(first).toHaveLength(7);
    expect(first.at(-1)!.event).not.toBe("done");

    const lastId = first.at(-1)!.id!;
    const rest = await readAll(await handleOverview(req("symbol=2330", { "Last-Event-ID": lastId }), deps));
    const all = [...first, ...rest];
    expect(all.map(seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)!.event).toBe("done");

    const reference = await readAll(await handleOverview(req("symbol=2330"), makeDeps()));
    expect(tokens(all)).toBe(tokens(reference));
  });

  it("starts a fresh stream when the resume id is unknown or expired", async () => {
    const msgs = await readAll(await handleOverview(req("symbol=2330", { "Last-Event-ID": "gone:12" }), makeDeps()));
    expect(msgs[0].event).toBe("meta");
    expect(seq(msgs[0])).toBe(1);
    expect(JSON.parse(msgs[0].data).streamId).not.toBe("gone");
  });

  it("stops generating when the client disappears and never comes back", async () => {
    const deps = makeDeps({ abandonAfterMs: 30 });
    deps.provider = createMockProvider(20);
    const ac = new AbortController();
    const res = await handleOverview(new Request("http://test/api/overview?symbol=2330", { signal: ac.signal }), deps);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    await sleep(100);
    expect(deps.store.size).toBe(0);
  });
});

describe("resumable client", () => {
  it("survives a mid-stream drop and renders the complete summary exactly once", async () => {
    const deps = makeDeps();
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      handleOverview(new Request(new URL(String(input), "http://test"), init), deps)) as typeof fetch;

    const events: OverviewEvent[] = [];
    const states: ConnectionState[] = [];
    const ac = new AbortController();
    const stream = openResumableStream({
      url: "/api/overview?symbol=2330&lang=en",
      fetchImpl,
      signal: ac.signal,
      baseDelayMs: 10,
      onEvent: (e) => {
        events.push(e);
        // pull the plug once the summary has started arriving
        if (e.type === "token" && events.filter((x) => x.type === "token").length === 3) stream.dropConnection();
      },
      onState: (s) => states.push(s),
    });
    await stream.done;

    expect(states.some((s) => s.kind === "reconnecting")).toBe(true);
    expect(states.some((s) => s.kind === "open" && s.resumedFrom)).toBe(true);
    expect(states.at(-1)).toEqual({ kind: "closed", reason: "done", detail: undefined });

    const text = events.flatMap((e) => (e.type === "token" ? [e.data.text] : [])).join("");
    const reference = await readAll(await handleOverview(req("symbol=2330&lang=en"), makeDeps()));
    expect(text).toBe(tokens(reference));
    expect(events.filter((e) => e.type === "meta")).toHaveLength(1);
  });

  it("detects a stream the server ended cleanly without `done`, and resumes", async () => {
    // No error is thrown here: the body simply ends. A naive client would show a half summary as complete.
    const deps = makeDeps();
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      handleOverview(new Request(new URL(String(input), "http://test"), init), deps)) as typeof fetch;

    const events: OverviewEvent[] = [];
    const states: ConnectionState[] = [];
    await openResumableStream({
      url: "/api/overview?symbol=2330&lang=en",
      firstUrl: "/api/overview?symbol=2330&lang=en&drop_after=8",
      fetchImpl,
      signal: new AbortController().signal,
      baseDelayMs: 10,
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
    }).done;

    expect(states.find((s) => s.kind === "reconnecting")).toMatchObject({ reason: "stream ended before completion" });
    expect(states.at(-1)).toMatchObject({ kind: "closed", reason: "done" });
    const text = events.flatMap((e) => (e.type === "token" ? [e.data.text] : [])).join("");
    const reference = await readAll(await handleOverview(req("symbol=2330&lang=en"), makeDeps()));
    expect(text).toBe(tokens(reference));
  });

  it("treats a silent connection as dead after the idle timeout, then resumes", async () => {
    // The connection stays open but nothing arrives: a stalled server or a half-dead TCP connection.
    // Neither an error nor an end-of-stream ever happens, so only the idle timer can catch it.
    const enc = new TextEncoder();
    const lastIds: (string | null)[] = [];
    let call = 0;
    const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
      call++;
      lastIds.push(new Headers(init?.headers).get("Last-Event-ID"));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // like real fetch: aborting the request errors the body stream
          init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
          if (call === 1) {
            c.enqueue(enc.encode(encodeSse("s:1", "meta", { streamId: "s", symbol: "2330", lang: "en", sourceUrl: "" })));
            // ...then silence, and the stream is never closed
          } else {
            c.enqueue(enc.encode(encodeSse("s:2", "done", { totalMs: 1, firstTokenMs: null })));
            c.close();
          }
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const events: string[] = [];
    const states: ConnectionState[] = [];
    const t0 = Date.now();
    await openResumableStream({
      url: "/x",
      fetchImpl,
      signal: new AbortController().signal,
      idleTimeoutMs: 80,
      baseDelayMs: 1,
      onEvent: (e) => events.push(e.type),
      onState: (s) => states.push(s),
    }).done;

    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(states.find((s) => s.kind === "reconnecting")).toMatchObject({ reason: expect.stringContaining("no data for") });
    expect(lastIds).toEqual([null, "s:1"]); // the reconnect resumed after the last event received
    expect(events).toEqual(["meta", "done"]);
    expect(states.at(-1)).toMatchObject({ kind: "closed", reason: "done" });
  });

  it("gives up after the retry budget when the server stays down", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const states: ConnectionState[] = [];
    await openResumableStream({
      url: "/x",
      fetchImpl,
      signal: new AbortController().signal,
      baseDelayMs: 1,
      maxRetries: 3,
      onEvent: () => {},
      onState: (s) => states.push(s),
    }).done;
    expect(states.filter((s) => s.kind === "reconnecting")).toHaveLength(3);
    expect(states.at(-1)).toMatchObject({ kind: "closed", reason: "gave_up" });
  });
});
