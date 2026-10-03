import { describe, expect, it } from "vitest";
import { createPageFetcher } from "@/lib/fetcher";
import { fixtureFetch } from "./helpers";

describe("createPageFetcher", () => {
  it("collapses concurrent requests into one upstream call and decodes Big5", async () => {
    const { impl, calls } = fixtureFetch(50);
    const get = createPageFetcher({ fetchImpl: impl });
    const pages = await Promise.all([get("u"), get("u"), get("u")]);
    expect(calls).toHaveLength(1);
    expect(new Set(pages.map((p) => p.body)).size).toBe(1);
    expect(pages[0].body).toContain("台積電");
    // the first caller triggered the request, the other two joined it
    expect(pages.map((p) => p.origin)).toEqual(["network", "shared", "shared"]);
    expect(new Set(pages.map((p) => p.startedAt)).size).toBe(1);
  });

  it("serves from cache within the TTL and refetches after it", async () => {
    const { impl, calls } = fixtureFetch();
    let now = 1_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const get = createPageFetcher({ fetchImpl: impl, ttlMs: 100 });
      expect((await get("u")).origin).toBe("network");
      expect((await get("u")).origin).toBe("cache");
      expect(calls).toHaveLength(1);
      now += 101;
      expect((await get("u")).origin).toBe("network");
      expect(calls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("one caller aborting does not cancel the shared request for others", async () => {
    const { impl, calls } = fixtureFetch(50);
    const get = createPageFetcher({ fetchImpl: impl });
    const ac = new AbortController();
    const a = get("u", ac.signal);
    const b = get("u");
    ac.abort(new Error("caller gave up"));
    await expect(a).rejects.toThrow("caller gave up");
    expect((await b).body).toContain("台積電");
    expect(calls).toHaveLength(1);
  });

  it("does not cache failures", async () => {
    let n = 0;
    const impl = (async () => (++n === 1 ? new Response("", { status: 503 }) : new Response("ok"))) as typeof fetch;
    const get = createPageFetcher({ fetchImpl: impl, retries: 0 });
    await expect(get("u")).rejects.toThrow("503");
    expect((await get("u")).body).toBe("ok");
  });

  it("retries once when the upstream hangs, and succeeds", async () => {
    let n = 0;
    const impl = ((_: unknown, init?: RequestInit) =>
      ++n === 1
        ? new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))
        : Promise.resolve(new Response("ok"))) as typeof fetch;
    const get = createPageFetcher({ fetchImpl: impl, timeoutMs: 30 });
    const page = await get("u");
    expect(page.body).toBe("ok");
    expect(page.attempts).toBe(2);
    expect(n).toBe(2);
  });

  it("reports the underlying network error and gives up after the retry", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    const get = createPageFetcher({ fetchImpl: impl });
    await expect(get("u")).rejects.toThrow("upstream fetch failed: ECONNRESET (after 2 attempts)");
    expect(n).toBe(2);
  });

  it("does not retry a 4xx", async () => {
    let n = 0;
    const impl = (async () => (n++, new Response("", { status: 404 }))) as typeof fetch;
    await expect(createPageFetcher({ fetchImpl: impl })("u")).rejects.toThrow("upstream responded 404");
    expect(n).toBe(1);
  });
});
