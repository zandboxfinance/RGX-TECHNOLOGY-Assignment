"use client";

import { useRef, useState, type FormEvent } from "react";
import type { Lang } from "@/lib/types";
import { GEMINI_KEY_URL, GEMINI_MODEL, GEMINI_MODEL_LABEL } from "@/lib/llm/model";
import { strings } from "./i18n";

type T = (typeof strings)[Lang];

/** Held in React state only: never written to storage, so a reload clears it. */
export type LlmChoice = { mode: "none" } | { mode: "demo" } | { mode: "gemini"; key: string };

/** The key travels in a header (fetch can set one, EventSource couldn't), never in the URL. */
export function llmHeaders(llm: LlmChoice): Record<string, string> {
  if (llm.mode === "gemini") return { "X-Gemini-Key": llm.key };
  if (llm.mode === "demo") return { "X-LLM-Mode": "demo" };
  return {};
}

/** First-run card shown in place of the summary until the user picks Gemini (with a key) or demo mode. */
export function KeySetup({ t, onUseKey, onDemo }: { t: T; onUseKey: (key: string) => void; onDemo: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; canOverride: boolean } | null>(null);

  async function verify(e: FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/llm/verify", { method: "POST", headers: { "X-Gemini-Key": k }, cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; message?: string };
      if (body.ok) return onUseKey(k);
      if (body.code === "invalid_key") return setProblem({ text: t.keyInvalid, canOverride: false });
      if (body.code === "quota") {
        // the key itself is fine; let them in and the run will report the quota if it persists
        setProblem({ text: t.keyQuotaOk, canOverride: true });
        return;
      }
      setProblem({ text: t.keyVerifyFailed(body.message ?? `HTTP ${res.status}`), canOverride: true });
    } catch (err) {
      setProblem({ text: t.keyVerifyFailed(err instanceof Error ? err.message : String(err)), canOverride: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="key-setup">
      <h3>
        <span className="spark">✦</span> {t.keyTitle}
      </h3>
      <p className="hint">{t.keyIntro(GEMINI_MODEL_LABEL)}</p>

      <form className="key-form" onSubmit={verify}>
        <div className="key-input">
          <input
            type={show ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t.keyPlaceholder}
            aria-label={t.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
          />
          <button type="button" className="ghost" onClick={() => setShow((s) => !s)}>
            {show ? t.keyHide : t.keyShow}
          </button>
        </div>
        <div className="key-actions">
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            {busy ? t.keyVerifying : t.keyVerify}
          </button>
          <a href={GEMINI_KEY_URL} target="_blank" rel="noopener noreferrer">
            {t.keyGet}
          </a>
        </div>
        {problem && (
          <p className="error">
            {problem.text}{" "}
            {problem.canOverride && (
              <button type="button" className="link" onClick={() => onUseKey(key.trim())}>
                {t.keyUseAnyway}
              </button>
            )}
          </p>
        )}
      </form>

      <p className="key-privacy">{t.keyPrivacy}</p>

      <div className="key-demo">
        <span>{t.demoOr}</span>
        <button type="button" onClick={onDemo}>
          🧪 {t.demoTry}
        </button>
        <span className="hint">{t.demoTryHint}</span>
      </div>
    </div>
  );
}

/** Toolbar chip: says which LLM is in use (Gemini or demo) and lets the user change it. */
export function LlmChip({
  t,
  llm,
  onChangeKey,
  onDemo,
}: {
  t: T;
  llm: LlmChoice;
  onChangeKey: () => void;
  onDemo: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const act = (fn: () => void) => () => {
    fn();
    if (menu.current) menu.current.open = false;
  };
  const label =
    llm.mode === "gemini" ? t.chipGemini(llm.key.slice(-4)) : llm.mode === "demo" ? t.chipDemo : t.chipNone;
  const icon = llm.mode === "demo" ? "🧪" : "✦";

  return (
    <details className={`llm-chip ${llm.mode}`} ref={menu}>
      <summary title={label}>
        <span className="spark">{icon}</span>
        <span className="llm-chip-text">{label}</span>
      </summary>
      <div className="llm-pop">
        <p>{t.chipAbout(GEMINI_MODEL_LABEL, GEMINI_MODEL)}</p>
        {llm.mode === "gemini" && <p className="hint">{t.chipMemoryNote}</p>}
        {llm.mode === "demo" && <p className="hint">{t.chipDemoNote}</p>}
        <div className="llm-pop-actions">
          {llm.mode !== "none" && (
            <button type="button" className="primary" onClick={act(onChangeKey)}>
              {llm.mode === "gemini" ? t.chipChange : t.chipToGemini}
            </button>
          )}
          {llm.mode !== "demo" && (
            <button type="button" onClick={act(onDemo)}>
              🧪 {t.chipToDemo}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
