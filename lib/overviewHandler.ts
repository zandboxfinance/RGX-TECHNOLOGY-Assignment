import type { Lang } from "@/lib/types";
import type { StreamStore } from "@/lib/streamStore";
import { runPipeline, type PipelineDeps } from "@/lib/pipeline";
import { encodeSse, formatEventId, parseEventId } from "@/lib/sse";

export interface HandlerDeps extends PipelineDeps {
  store: StreamStore;
  keepAliveMs?: number;
}

const TERMINAL = new Set(["done", "error"]);

/**
 * GET /api/overview?symbol=2330&lang=zh-TW
 *
 * - No Last-Event-ID (or an expired one): start a new run and stream it from the beginning.
 * - Last-Event-ID "<streamId>:<seq>" of a live run: replay everything after <seq>, then continue live.
 *   The id can also be passed as ?lastEventId= for curl.
 * - ?drop_after=N: debug switch; the server closes this connection after N events to simulate a
 *   network drop, so the client's reconnect path can be demonstrated on demand.
 */
export async function handleOverview(req: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "2330").trim().toUpperCase();
  if (!/^\d{4,6}[A-Z]?$/.test(symbol)) {
    return Response.json({ error: "symbol must look like a TWSE code, e.g. 2330" }, { status: 400 });
  }
  const lang: Lang = url.searchParams.get("lang") === "en" ? "en" : "zh-TW";
  const dropAfter = Math.max(0, Number(url.searchParams.get("drop_after")) || 0);

  const last = parseEventId(req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId"));
  let session = last ? deps.store.get(last.streamId) : undefined;
  let afterSeq = 0;
  if (session && last) {
    afterSeq = last.seq;
  } else {
    // A new run. If the client asked to resume an expired stream, it will notice the new
    // streamId in the `meta` event and reset its view.
    session = deps.store.create();
    void runPipeline(session, { symbol, lang }, deps);
  }

  const s = session;
  const encoder = new TextEncoder();
  const connection = new AbortController();
  req.signal.addEventListener("abort", () => connection.abort(), { once: true });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          connection.abort(); // client is gone
        }
      };
      // Keeps proxies from closing an idle stream and lets the client use a read timeout to
      // detect a silently dead connection.
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), deps.keepAliveMs ?? 10_000);
      let sent = 0;
      try {
        for await (const { seq, event } of s.subscribe(afterSeq, connection.signal)) {
          send(encodeSse(formatEventId(s.id, seq), event.type, event.data));
          if (dropAfter && ++sent >= dropAfter && !TERMINAL.has(event.type)) break;
        }
      } finally {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      connection.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
