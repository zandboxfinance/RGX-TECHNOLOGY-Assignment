import { createSseParser } from "@/lib/sse";
import type { OverviewEvent } from "@/lib/types";

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "open"; resumedFrom?: string }
  | { kind: "reconnecting"; attempt: number; delayMs: number; reason: string }
  | { kind: "closed"; reason: "done" | "error" | "aborted" | "gave_up"; detail?: string };

export interface StreamOptions {
  url: string;
  /** URL for the first attempt only (e.g. with ?drop_after=N); reconnects use `url`. */
  firstUrl?: string;
  onEvent: (e: OverviewEvent, id: string | undefined) => void;
  onState: (s: ConnectionState) => void;
  signal: AbortSignal;
  maxRetries?: number;
  baseDelayMs?: number;
  /** No bytes (not even a keep-alive) for this long → treat the connection as dead. */
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * SSE over fetch() with resume. Uses fetch rather than EventSource because EventSource retries
 * silently in the background; here every drop is visible and the retry policy is ours.
 *
 * A connection counts as dropped if the request fails, the body errors, nothing arrives within
 * `idleTimeoutMs`, or the stream ends before a terminal `done`/`error` event. On a drop we back off
 * exponentially and reconnect with `Last-Event-ID`, so the server resumes right after the last event
 * we rendered: no duplicated or missing tokens.
 */
export function openResumableStream(opts: StreamOptions): { done: Promise<void>; dropConnection: () => void } {
  const { onEvent, onState, signal } = opts;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 25_000;
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  let attemptCtl: AbortController | null = null;

  const done = (async () => {
    let lastEventId: string | undefined;
    let failures = 0;
    let first = true;

    while (true) {
      attemptCtl = new AbortController();
      const attemptSignal = AbortSignal.any([signal, attemptCtl.signal]);
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => attemptCtl?.abort(new Error(`no data for ${idleTimeoutMs / 1000}s`)), idleTimeoutMs);
      };
      let terminal: "done" | "error" | null = null;
      let terminalDetail: string | undefined;
      let reason: string;

      try {
        if (failures === 0) onState({ kind: "connecting" });
        const res = await fetchImpl(first && opts.firstUrl ? opts.firstUrl : opts.url, {
          headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
          signal: attemptSignal,
          cache: "no-store",
        });
        first = false;
        if (res.status >= 400 && res.status < 500) {
          onState({ kind: "closed", reason: "error", detail: `HTTP ${res.status}: ${await res.text()}` });
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState({ kind: "open", resumedFrom: lastEventId });
        armIdle();

        const parse = createSseParser((m) => {
          if (m.id) lastEventId = m.id;
          failures = 0; // made progress, so the retry budget starts over
          const event = { type: m.event, data: JSON.parse(m.data) } as OverviewEvent;
          if (event.type === "done") terminal = "done";
          if (event.type === "error") {
            terminal = "error";
            terminalDetail = event.data.message;
          }
          onEvent(event, m.id);
        });

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
          parse(value);
        }
        if (terminal) {
          onState({ kind: "closed", reason: terminal, detail: terminalDetail });
          return;
        }
        reason = "stream ended before completion";
      } catch (err) {
        if (signal.aborted) {
          onState({ kind: "closed", reason: "aborted" });
          return;
        }
        const r = attemptCtl.signal.reason;
        reason = attemptCtl.signal.aborted && r instanceof Error ? r.message : errMessage(err);
      } finally {
        clearTimeout(idle);
      }

      failures++;
      if (failures > maxRetries) {
        onState({ kind: "closed", reason: "gave_up", detail: reason });
        return;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (failures - 1), 8_000) + Math.floor(Math.random() * 200);
      onState({ kind: "reconnecting", attempt: failures, delayMs, reason });
      if (!(await sleep(delayMs, signal))) {
        onState({ kind: "closed", reason: "aborted" });
        return;
      }
    }
  })();

  return {
    done,
    // Simulates a network failure on the current connection only; the retry loop keeps running.
    dropConnection: () => attemptCtl?.abort(new Error("simulated network drop")),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => (clearTimeout(t), resolve(false));
    const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve(true)), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
