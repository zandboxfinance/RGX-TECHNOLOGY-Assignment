import { readFileSync } from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

/** Real page snapshot (Big5 bytes) captured 2026-10-03, trading day 10/02. */
export const fixtureBytes = readFileSync(path.join(import.meta.dirname, "fixtures/ZCX_2330.big5.html"));
export const fixtureHtml = iconv.decode(fixtureBytes, "big5");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch stub that serves the Big5 fixture and counts calls. */
export function fixtureFetch(delayMs = 0) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    await sleep(delayMs);
    return new Response(fixtureBytes, { headers: { "content-type": "text/html;Charset=big5" } });
  }) as typeof fetch;
  return { impl, calls };
}
