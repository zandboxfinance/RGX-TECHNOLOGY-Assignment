import type { Agent } from "@/lib/types";
import type { FetchPage } from "@/lib/fetcher";
import { createScrapeAgent, type FieldSpec } from "./scrapeAgent";

// Agent A — Price
export const PRICE_FIELDS: FieldSpec[] = [
  { key: "open", label: "Open", labelZh: "開盤價", pageLabels: ["開盤價"], unit: "TWD" },
  { key: "high", label: "High", labelZh: "最高價", pageLabels: ["最高價"], unit: "TWD" },
  { key: "low", label: "Low", labelZh: "最低價", pageLabels: ["最低價"], unit: "TWD" },
  { key: "close", label: "Close", labelZh: "收盤價", pageLabels: ["收盤價"], unit: "TWD" },
  { key: "change", label: "Change", labelZh: "漲跌", pageLabels: ["漲跌"], unit: "TWD" },
  { key: "volume", label: "Volume", labelZh: "成交量", pageLabels: ["成交量"], unit: "lots" },
  { key: "high52w", label: "52-week high", labelZh: "52 週最高", pageLabels: ["一年內最高價"], unit: "TWD" },
  { key: "low52w", label: "52-week low", labelZh: "52 週最低", pageLabels: ["一年內最低價"], unit: "TWD" },
];

// Agent B — Valuation
export const VALUATION_FIELDS: FieldSpec[] = [
  { key: "pe", label: "P/E", labelZh: "本益比", pageLabels: ["本益比"], unit: "x" },
  { key: "industryPe", label: "Industry avg P/E", labelZh: "同業平均本益比", pageLabels: ["同業平均本益比"], unit: "x" },
  { key: "marketCap", label: "Market cap", labelZh: "總市值", pageLabels: ["總市值"], unit: "TWD mn" },
  { key: "pb", label: "P/B", labelZh: "股價淨值比", pageLabels: ["股價淨值比"], unit: "x" },
];

// Agent C — Financial health
export const FINANCIAL_FIELDS: FieldSpec[] = [
  { key: "bvps", label: "Book value / share", labelZh: "每股淨值", pageLabels: ["每股淨值(元)", "每股淨值"], unit: "TWD" },
  { key: "debtRatio", label: "Debt ratio", labelZh: "負債比率", pageLabels: ["負債比例", "負債比率"], unit: "%" },
  { key: "beta", label: "Beta", labelZh: "貝他值", pageLabels: ["貝他值", "Beta值"], unit: "" },
  { key: "stdDev", label: "Std deviation", labelZh: "標準差", pageLabels: ["標準差"], unit: "%" },
  { key: "returnYtd", label: "Return YTD", labelZh: "今年以來報酬", pageLabels: ["今年以來"], unit: "%" },
  { key: "return1w", label: "Return 1W", labelZh: "近一週報酬", pageLabels: ["最近一週"], unit: "%" },
  { key: "return1m", label: "Return 1M", labelZh: "近一個月報酬", pageLabels: ["最近一個月"], unit: "%" },
  { key: "return3m", label: "Return 3M", labelZh: "近三個月報酬", pageLabels: ["最近三個月"], unit: "%" },
];

export function createAgents(fetchPage: FetchPage): Agent[] {
  return [
    createScrapeAgent("price", PRICE_FIELDS, fetchPage),
    createScrapeAgent("valuation", VALUATION_FIELDS, fetchPage),
    createScrapeAgent("financial", FINANCIAL_FIELDS, fetchPage),
  ];
}
