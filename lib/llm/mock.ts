import type { AgentResult } from "@/lib/types";
import type { SummaryInput, SummaryProvider } from "./types";
import { LlmError } from "./errors";
import { GEMINI_MODEL } from "./model";

const GEMINI_PROVIDER_NAME = `gemini:${GEMINI_MODEL}`;

/**
 * Deterministic stand-in for the LLM: the UI's demo mode, and the tests.
 * Builds the summary from a template and streams it in small chunks with a delay, so the
 * streaming, resume and disconnect paths behave exactly as they do with a real model.
 */
/**
 * Failure demo: behaves like Gemini failing with a 503 "high demand", without calling Gemini.
 *   overloaded           – fails before any text, after a short wait (the common case)
 *   overloaded_midstream – streams part of the summary, then fails (leaves an incomplete summary)
 */
export type SimulatedFailure = "overloaded" | "overloaded_midstream";

export function createFailingProvider(kind: SimulatedFailure, chunkDelayMs = 40): SummaryProvider {
  const inner = createMockProvider(chunkDelayMs);
  return {
    name: `${GEMINI_PROVIDER_NAME} (simulated failure)`,
    simulated: true,
    async *stream(input, signal) {
      if (kind === "overloaded") {
        await sleep(700, signal);
      } else {
        let n = 0;
        for await (const chunk of inner.stream(input, signal)) {
          yield chunk;
          if (++n === 12) break;
        }
      }
      if (signal.aborted) return;
      throw new LlmError("Gemini is experiencing high demand (503); try again shortly", "overloaded");
    },
  };
}

export function createMockProvider(chunkDelayMs = 40): SummaryProvider {
  return {
    name: "demo",
    async *stream(input, signal) {
      const text = input.lang === "zh-TW" ? zh(input) : en(input);
      for (const chunk of text.match(/[\s\S]{1,4}/g) ?? []) {
        if (signal.aborted) return;
        await sleep(chunkDelayMs, signal);
        yield chunk;
      }
    },
  };
}

function v(results: AgentResult[], key: string): number | null {
  for (const r of results) {
    const f = r.fields.find((x) => x.key === key);
    if (f) return f.value;
  }
  return null;
}

const n = (x: number | null, digits = 2) => (x === null ? "n/a" : x.toLocaleString("en-US", { maximumFractionDigits: digits }));

function en({ symbol, asOf, results }: SummaryInput): string {
  const pe = v(results, "pe"), ipe = v(results, "industryPe");
  const rel = pe !== null && ipe !== null ? (pe < ipe ? "below" : "above") : "vs.";
  return [
    `[Demo mode: template, not AI-generated] ${symbol} as of ${asOf ?? "n/a"}:`,
    `• Price: closed at ${n(v(results, "close"))} (${n(v(results, "change"))}), within a 52-week range of ${n(v(results, "low52w"))}–${n(v(results, "high52w"))}.`,
    `• Valuation: P/E ${n(pe)} ${rel} the industry average ${n(ipe)}; P/B ${n(v(results, "pb"))}, market cap ${n(v(results, "marketCap"), 0)} TWD mn.`,
    `• Financial health: debt ratio ${n(v(results, "debtRatio"))}%, beta ${n(v(results, "beta"))}, YTD return ${n(v(results, "returnYtd"))}%.`,
    missingNote(results, "en"),
    `Takeaway: enter a Gemini API key to have an LLM write this summary.`,
  ].filter(Boolean).join("\n");
}

function zh({ symbol, asOf, results }: SummaryInput): string {
  const pe = v(results, "pe"), ipe = v(results, "industryPe");
  const rel = pe !== null && ipe !== null ? (pe < ipe ? "低於" : "高於") : "對比";
  return [
    `【示範模式：模板產生，非 AI】${symbol}（資料日 ${asOf ?? "n/a"}）`,
    `• 股價：收盤 ${n(v(results, "close"))}（漲跌 ${n(v(results, "change"))}），一年區間 ${n(v(results, "low52w"))}–${n(v(results, "high52w"))}。`,
    `• 評價：本益比 ${n(pe)}，${rel}同業平均 ${n(ipe)}；股價淨值比 ${n(v(results, "pb"))}，總市值 ${n(v(results, "marketCap"), 0)} 百萬元。`,
    `• 財務體質：負債比 ${n(v(results, "debtRatio"))}%，貝他值 ${n(v(results, "beta"))}，今年以來報酬 ${n(v(results, "returnYtd"))}%。`,
    missingNote(results, "zh-TW"),
    `結論：輸入 Gemini API key 即可改由 LLM 生成摘要。`,
  ].filter(Boolean).join("\n");
}

function missingNote(results: AgentResult[], lang: SummaryInput["lang"]): string {
  const failed = results.filter((r) => r.status === "error").map((r) => r.agent);
  if (!failed.length) return "";
  return lang === "zh-TW" ? `• 注意：${failed.join("、")} 資料暫時無法取得。` : `• Note: ${failed.join(", ")} data unavailable.`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => (clearTimeout(t), resolve());
    const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
