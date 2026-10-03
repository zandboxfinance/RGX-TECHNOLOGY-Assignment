import { describe, expect, it } from "vitest";
import { StreamStore } from "@/lib/streamStore";
import type { OverviewEvent } from "@/lib/types";
import { sleep } from "./helpers";

const tok = (text: string): OverviewEvent => ({ type: "token", data: { text } });

async function collect(gen: AsyncGenerator<{ seq: number }>) {
  const seqs: number[] = [];
  for await (const e of gen) seqs.push(e.seq);
  return seqs;
}

describe("StreamSession", () => {
  it("replays the backlog after a given seq, then follows live events until finished", async () => {
    const store = new StreamStore({ abandonAfterMs: 1_000, retainAfterDoneMs: 1_000 });
    const s = store.create();
    s.append(tok("a"));
    s.append(tok("b"));
    s.append(tok("c"));

    const pending = collect(s.subscribe(1, new AbortController().signal));
    await sleep(10);
    s.append(tok("d"));
    s.finish();
    expect(await pending).toEqual([2, 3, 4]);
  });

  it("aborts generation when nobody reconnects in time", async () => {
    const store = new StreamStore({ abandonAfterMs: 50, retainAfterDoneMs: 1_000 });
    const s = store.create();
    const conn = new AbortController();
    const sub = collect(s.subscribe(0, conn.signal));
    await sleep(5);
    conn.abort(); // client dropped
    await sub;

    expect(s.signal.aborted).toBe(false); // grace period
    await sleep(80);
    expect(s.signal.aborted).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
  });

  it("a reconnect within the grace period cancels abandonment", async () => {
    const store = new StreamStore({ abandonAfterMs: 50, retainAfterDoneMs: 1_000 });
    const s = store.create();
    const first = new AbortController();
    const sub1 = collect(s.subscribe(0, first.signal));
    await sleep(5);
    first.abort();
    await sub1;

    await sleep(20);
    const sub2 = collect(s.subscribe(0, new AbortController().signal));
    await sleep(80);
    expect(s.signal.aborted).toBe(false);
    s.finish();
    await sub2;
  });

  it("keeps a finished stream for late replays, then expires it", async () => {
    const store = new StreamStore({ abandonAfterMs: 1_000, retainAfterDoneMs: 40 });
    const s = store.create();
    s.append(tok("a"));
    s.finish();
    expect(await collect(s.subscribe(0, new AbortController().signal))).toEqual([1]);
    await sleep(60);
    expect(store.get(s.id)).toBeUndefined();
  });
});
