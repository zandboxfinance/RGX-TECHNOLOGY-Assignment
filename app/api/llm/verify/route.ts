import { verifyGeminiKey } from "@/lib/llm/gemini";
import { classifyLlmError } from "@/lib/llm/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST with X-Gemini-Key: checks the key before the user runs a query. The key is not stored. */
export async function POST(req: Request) {
  const key = req.headers.get("x-gemini-key")?.trim();
  if (!key) return Response.json({ ok: false, code: "missing_api_key" }, { status: 400 });
  try {
    await verifyGeminiKey(key, AbortSignal.timeout(8_000));
    return Response.json({ ok: true });
  } catch (err) {
    const e = classifyLlmError(err);
    const status = e.code === "invalid_key" ? 401 : e.code === "quota" ? 429 : 502;
    return Response.json({ ok: false, code: e.code, message: e.message }, { status });
  }
}
