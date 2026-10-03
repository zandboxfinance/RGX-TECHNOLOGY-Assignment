import { randomUUID } from "node:crypto";
import type { OverviewEvent } from "@/lib/types";

export interface StoredEvent {
  seq: number;
  event: OverviewEvent;
}

interface SessionOptions {
  /** Abort generation if no client has been attached for this long. */
  abandonAfterMs: number;
  /** Keep a finished stream around this long so a late reconnect can still replay it. */
  retainAfterDoneMs: number;
}

/**
 * One generation run, decoupled from any HTTP connection.
 *
 * The pipeline appends events; connections subscribe from a sequence number and get the backlog
 * followed by live events. A dropped connection just detaches: generation keeps going, and a
 * reconnect with Last-Event-ID picks up exactly where it left off. If nobody reattaches within
 * `abandonAfterMs`, the run is aborted so we don't burn LLM quota for no one.
 */
export class StreamSession {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  private readonly events: StoredEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private subscribers = 0;
  private abandonTimer?: ReturnType<typeof setTimeout>;
  private done = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly onExpire: (id: string) => void,
  ) {}

  /** Aborted when the session is abandoned; the pipeline passes it to agents and the LLM. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDone(): boolean {
    return this.done;
  }

  get lastSeq(): number {
    return this.events.length;
  }

  append(event: OverviewEvent): void {
    if (this.done) return;
    this.events.push({ seq: this.events.length + 1, event });
    this.notify();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.abandonTimer);
    this.notify();
    unref(setTimeout(() => this.onExpire(this.id), this.opts.retainAfterDoneMs));
  }

  /** Yields every event with seq > afterSeq, then live events until the run finishes or `signal` aborts. */
  async *subscribe(afterSeq: number, signal: AbortSignal): AsyncGenerator<StoredEvent> {
    this.attach();
    try {
      let cursor = Math.max(0, afterSeq);
      while (!signal.aborted) {
        while (cursor < this.events.length) yield this.events[cursor++];
        if (this.done) return;
        await this.waitForChange(signal);
      }
    } finally {
      this.detach();
    }
  }

  private attach() {
    this.subscribers++;
    clearTimeout(this.abandonTimer);
    this.abandonTimer = undefined;
  }

  private detach() {
    this.subscribers--;
    if (this.subscribers > 0 || this.done) return;
    this.abandonTimer = unref(
      setTimeout(() => {
        this.controller.abort(new Error("abandoned: no client reconnected"));
        this.finish();
        this.onExpire(this.id);
      }, this.opts.abandonAfterMs),
    );
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.waiters.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      this.waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  private notify() {
    for (const wake of [...this.waiters]) wake();
  }
}

/**
 * In-memory registry of sessions. Works for a single Node process (`next dev` / `next start`).
 * With several instances or serverless, this would move to Redis Streams (XADD / XREAD from an id).
 */
export class StreamStore {
  private readonly sessions = new Map<string, StreamSession>();

  constructor(private readonly opts: SessionOptions = { abandonAfterMs: 60_000, retainAfterDoneMs: 5 * 60_000 }) {}

  create(): StreamSession {
    const s = new StreamSession(this.opts, (id) => this.sessions.delete(id));
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): StreamSession | undefined {
    return this.sessions.get(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}

function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}
