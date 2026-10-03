/**
 *   invalid_key – the key is wrong or revoked: retrying won't help, the user needs a new key
 *   quota       – 429, free-tier limit: retry after a minute or so
 *   overloaded  – 503 "model is experiencing high demand": temporary, retry shortly
 *   llm_error   – anything else (500/504, timeout, network): may work on retry
 */
import { GEMINI_MODEL } from "./model";

export type LlmErrorCode = "invalid_key" | "quota" | "overloaded" | "llm_error";

/** An LLM failure the UI can act on: an invalid key needs a new key, the rest can be retried. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.code !== "invalid_key";
  }
}

/** Maps Gemini SDK errors (ApiError carries the HTTP status) to codes. Never echoes the key. */
export function classifyLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) {
    return new LlmError("invalid API key", "invalid_key");
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return new LlmError("Gemini rate limit or free-tier quota reached", "quota");
  }
  if (status === 503 || /UNAVAILABLE|overloaded|high demand/i.test(msg)) {
    return new LlmError("Gemini is experiencing high demand (503); try again shortly", "overloaded");
  }
  if (status === 404 || /NOT_FOUND/.test(msg)) {
    return new LlmError(`model ${GEMINI_MODEL} is not available for this key`, "llm_error");
  }
  if (err instanceof DOMException && err.name === "TimeoutError") return new LlmError("Gemini did not respond in time", "llm_error");
  return new LlmError(redact(msg).slice(0, 200), "llm_error");
}

/** Defense in depth: strip anything shaped like a Google API key before a message leaves the server. */
function redact(s: string): string {
  return s.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]");
}
