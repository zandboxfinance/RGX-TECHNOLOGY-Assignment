import { describe, expect, it } from "vitest";
import { extractAsOf, extractLabelValues, parseNumber } from "@/lib/parse";
import { createAgents } from "@/lib/agents";
import { fixtureHtml } from "./helpers";

const values = (r: { fields: { key: string; value: number | null }[] }) =>
  Object.fromEntries(r.fields.map((f) => [f.key, f.value]));

const run = (html: string) => {
  const signal = new AbortController().signal;
  const page = async () => ({ body: html, origin: "network" as const, startedAt: 0, endedAt: 0, attempts: 1 });
  return Promise.all(createAgents(page).map((a) => a.run({ symbol: "2330", signal })));
};

describe("parseNumber", () => {
  it.each([
    ["2,505.00", 2505],
    ["63.38%", 63.38],
    ["-10.00", -10],
    ["64,830,925", 64830925],
    ["N/A", null],
    ["--", null],
    [" ", null],
    [undefined, null],
  ])("%s → %s", (raw, expected) => expect(parseNumber(raw)).toBe(expected));
});

describe("page parsing against the real snapshot", () => {
  it("reads labels across <br> and skips commented-out cells", () => {
    const cells = extractLabelValues(fixtureHtml);
    expect(cells.get("一年內最高價")).toBe("2,535.00");
    expect(cells.has("買進")).toBe(false);
    expect(extractAsOf(fixtureHtml)).toBe("10/02");
  });

  it("each agent extracts its block", async () => {
    const [price, valuation, financial] = await run(fixtureHtml);

    expect(price.status).toBe("ok");
    expect(values(price)).toEqual({
      open: 2505, high: 2515, low: 2495, close: 2500, change: -10,
      volume: 15825, high52w: 2535, low52w: 1365,
    });

    expect(valuation.status).toBe("ok");
    expect(values(valuation)).toEqual({ pe: 28.98, industryPe: 54.78, marketCap: 64830925, pb: 10.08 });

    expect(financial.status).toBe("ok");
    expect(values(financial)).toEqual({
      bvps: 248.05, debtRatio: 30.94, beta: 1.07, stdDev: 2.04,
      returnYtd: 63.38, return1w: 1.41, return1m: 5.55, return3m: 2.13,
    });
    expect(financial.asOf).toBe("10/02");
  });

  it("degrades to partial when a label disappears", async () => {
    const [, valuation] = await run(fixtureHtml.replace("股價淨值比", "某新欄位"));
    expect(valuation.status).toBe("partial");
    expect(valuation.missing).toEqual(["pb"]);
    expect(values(valuation).pe).toBe(28.98);
  });

  it("fails loudly when none of an agent's labels are present", async () => {
    await expect(run("<html><body>查無資料</body></html>")).rejects.toThrow(/none of the price fields/);
  });
});
