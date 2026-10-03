import iconv from "iconv-lite";

/**
 * How a caller got the page:
 *   network – this caller triggered the upstream request
 *   shared  – joined a request another caller had already started (single-flight)
 *   cache   – served from the TTL cache, no request at all
 */
export type FetchOrigin = "network" | "shared" | "cache";

export interface FetchedPage {
  body: string;
  origin: FetchOrigin;
  /** Epoch ms of the upstream request that produced `body` (for a cache hit, the original request). */
  startedAt: number;
  endedAt: number;
  attempts: number;
}

export type FetchPage = (url: string, signal?: AbortSignal) => Promise<FetchedPage>;

type Loaded = Omit<FetchedPage, "origin">;

interface FetcherOptions {
  ttlMs?: number;
  /** Per attempt. */
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class UpstreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/**
 * Page fetcher shared by all agents.
 *
 * - single-flight: concurrent requests for the same URL share one HTTP call, so three
 *   independent agents cost one request to the broker.
 * - short TTL cache: repeated questions within `ttlMs` don't refetch.
 * - decodes using the charset from Content-Type (the Fubon page is Big5).
 *
 * A caller's AbortSignal only detaches that caller; it never cancels the shared request
 * other agents may be waiting on.
 */
export function createPageFetcher(opts: FetcherOptions = {}): FetchPage {
  const ttlMs = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retries = opts.retries ?? 1;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const inflight = new Map<string, Promise<Loaded>>();
  const cache = new Map<string, { page: Loaded; expires: number }>();

  async function attempt(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0 (stock-overview-agents)" },
      });
      if (!res.ok) throw new UpstreamError(`upstream responded ${res.status}`, res.status >= 500);
      const buf = Buffer.from(await res.arrayBuffer());
      return iconv.decode(buf, charsetOf(res.headers.get("content-type")));
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new UpstreamError(`upstream did not respond within ${timeoutMs / 1000}s`, true);
      }
      // undici reports the real reason (ECONNRESET, ENOTFOUND, ...) in `cause`
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new UpstreamError(`upstream fetch failed: ${cause?.code ?? cause?.message ?? (err as Error).message}`, true);
    }
  }

  // One retry for transient failures (timeout, network error, 5xx). A 4xx is not retried.
  async function load(url: string): Promise<Loaded> {
    const startedAt = Date.now();
    let attempts = 1;
    let body: string;
    try {
      body = await attempt(url);
    } catch (err) {
      if (!(err instanceof UpstreamError) || !err.retryable || retries < 1) throw err;
      attempts++;
      body = await attempt(url).catch((e: Error) => {
        throw new UpstreamError(`${e.message} (after ${retries + 1} attempts)`, false);
      });
    }
    return { body, startedAt, endedAt: Date.now(), attempts };
  }

  return (url, signal) => {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return Promise.resolve({ ...hit.page, origin: "cache" });

    let origin: FetchOrigin = "shared";
    let p = inflight.get(url);
    if (!p) {
      origin = "network";
      p = load(url)
        .then((page) => {
          cache.set(url, { page, expires: Date.now() + ttlMs });
          return page;
        })
        .finally(() => inflight.delete(url));
      inflight.set(url, p);
    }
    const tagged = p.then((page) => ({ ...page, origin }));
    return signal ? raceAbort(tagged, signal) : tagged;
  };
}

function charsetOf(contentType: string | null): string {
  const m = contentType?.match(/charset=([\w-]+)/i);
  const cs = m?.[1] ?? "big5";
  return iconv.encodingExists(cs) ? cs : "big5";
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
