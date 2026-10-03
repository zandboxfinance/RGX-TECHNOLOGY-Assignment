import * as cheerio from "cheerio";

/**
 * The page is a single label/value grid: `<td class="t3n0">label</td><td class="t3n1">value</td>`,
 * with the price, valuation and financial fields interleaved in the same table (e.g. P/E sits in a
 * price row, P/B in the financial-ratio column). So we don't rely on positions or blocks: we index
 * every cell by its normalized text and read the cell right after it.
 *
 * Commented-out cells (`<!--<td>買進</td>-->`) are ignored by the HTML parser, which is what we want.
 */
export function extractLabelValues(html: string): Map<string, string> {
  const $ = cheerio.load(html);
  const out = new Map<string, string>();
  $("td").each((_, el) => {
    const label = normalizeLabel($(el).text());
    if (!label || label.length > 20 || out.has(label)) return;
    const next = $(el).next("td");
    if (next.length) out.set(label, next.text().trim());
  });
  return out;
}

/** "一年內<br>最高價" → "一年內最高價"; also drops &nbsp; and full-width spaces. */
export function normalizeLabel(s: string): string {
  return s.replace(/[\s 　]+/g, "");
}

/** "2,505.00" → 2505, "63.38%" → 63.38, "N/A" / "--" / "" → null. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.replace(/[,%\s ]/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** "最近交易日:10/02" → "10/02" */
export function extractAsOf(html: string): string | null {
  return html.match(/最近交易日[:：]\s*([\d/]+)/)?.[1] ?? null;
}
