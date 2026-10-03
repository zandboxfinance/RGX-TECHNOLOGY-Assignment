"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { openResumableStream, type ConnectionState } from "@/lib/client/resumableStream";
import { renderMarkdown } from "@/lib/client/markdown";
import type { AgentName, AgentResult, Field, Lang, OverviewEvent, RunError } from "@/lib/types";
import { strings } from "./i18n";
import { Timeline, type ConnTrack } from "./Timeline";
import { KeySetup, LlmChip, llmHeaders, type LlmChoice } from "./LlmSettings";
import { GEMINI_MODEL_LABEL } from "@/lib/llm/model";

type T = (typeof strings)[Lang];
const AGENTS: AgentName[] = ["price", "valuation", "financial"];

interface View {
  streamId: string | null;
  sourceUrl: string | null;
  results: Partial<Record<AgentName, AgentResult>>;
  summary: string;
  provider: string | null;
  /** Server-side offset (ms from request start) at which synthesis began. */
  synthesisAt: number | null;
  /** Client-side estimate of the first token, used until `done` brings the server's number. */
  firstTokenAt: number | null;
  timing: { firstTokenMs: number | null; totalMs: number } | null;
  /** How the run failed, if it did (Gemini error, all agents failed). Shown in the summary, status and timeline. */
  runError: RunError | null;
  /** Client connection history on the same clock as the server offsets, for the timeline. */
  conn: ConnTrack;
  log: { text: string; sys?: boolean }[];
}

const empty: View = {
  streamId: null,
  sourceUrl: null,
  results: {},
  summary: "",
  provider: null,
  synthesisAt: null,
  firstTokenAt: null,
  timing: null,
  runError: null,
  conn: { segments: [], drops: [], resumes: [] },
  log: [],
};

type Action =
  | { type: "reset" }
  | { type: "event"; event: OverviewEvent; id?: string; at: number }
  | { type: "log"; text: string }
  | { type: "conn"; state: ConnectionState; at: number };

function reducer(v: View, a: Action): View {
  if (a.type === "reset") return empty;
  if (a.type === "log") return { ...v, log: [...v.log, { text: a.text, sys: true }] };
  if (a.type === "conn") return { ...v, conn: trackConnection(v.conn, a.state, a.at) };

  const e = a.event;
  const log = [...v.log, { text: `${shortId(a.id)}  ${e.type}  ${e.type === "token" ? JSON.stringify(e.data.text) : ""}` }];
  switch (e.type) {
    case "meta":
      // A different streamId after a reconnect means the old run expired server-side and a fresh one
      // started: drop the stale partial view instead of appending to it.
      if (v.streamId && v.streamId !== e.data.streamId) {
        return {
          ...empty,
          streamId: e.data.streamId,
          sourceUrl: e.data.sourceUrl,
          conn: v.conn,
          log: [...log, { text: "previous stream expired; restarted", sys: true }],
        };
      }
      return { ...v, streamId: e.data.streamId, sourceUrl: e.data.sourceUrl, log };
    case "agent_result":
      return { ...v, results: { ...v.results, [e.data.agent]: e.data }, log };
    case "synthesis_start":
      return { ...v, provider: e.data.provider, synthesisAt: e.data.atMs, log };
    case "token":
      return { ...v, summary: v.summary + e.data.text, firstTokenAt: v.firstTokenAt ?? a.at, log };
    case "done":
      return { ...v, timing: e.data, log };
    case "error":
      return { ...v, runError: e.data, log };
  }
}

/** "8f3c2a1e-…-uuid:17" → "8f3c2a1e:17": the full stream id adds nothing to the log but width. */
function shortId(id: string | undefined): string {
  if (!id) return "-";
  const i = id.lastIndexOf(":");
  return i > 8 ? `${id.slice(0, 8)}${id.slice(i)}` : id;
}

function trackConnection(c: ConnTrack, s: ConnectionState, at: number): ConnTrack {
  const closeOpen = () => c.segments.map((seg) => (seg.to === null ? { ...seg, to: at } : seg));
  switch (s.kind) {
    case "open":
      return {
        ...c,
        segments: [...c.segments, { from: s.resumedFrom ? at : 0, to: null }],
        resumes: s.resumedFrom ? [...c.resumes, { at, seq: s.resumedFrom.split(":").pop() ?? "?" }] : c.resumes,
      };
    case "reconnecting": {
      // Only the first failed attempt after a live connection is a new drop; later attempts are retries.
      const wasOpen = c.segments.some((seg) => seg.to === null);
      return wasOpen ? { ...c, segments: closeOpen(), drops: [...c.drops, { at, reason: s.reason }] } : c;
    }
    case "closed":
      return { ...c, segments: closeOpen() };
    default:
      return c;
  }
}

export default function Page() {
  const [symbol, setSymbol] = useState("2330");
  const [lang, setLang] = useState<Lang>("zh-TW");
  const [view, dispatch] = useReducer(reducer, empty);
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Memory only, by design: the key is never written to storage and is gone after a reload.
  const [llm, setLlm] = useState<LlmChoice>({ mode: "none" });
  const [now, setNow] = useState(0);
  const run = useRef<{ abort: AbortController; drop: () => void; t0: number; aligned: boolean } | null>(null);
  const t = strings[lang];

  const streaming = conn?.kind === "open" || conn?.kind === "connecting" || conn?.kind === "reconnecting";
  const elapsed = () => (run.current?.aligned ? performance.now() - run.current.t0 : 0);

  useEffect(() => () => run.current?.abort.abort(), []);

  // Drives the live timeline while a run is in progress.
  useEffect(() => {
    if (!streaming || view.timing) return;
    const id = setInterval(() => setNow(elapsed()), 50);
    return () => clearInterval(id);
  }, [streaming, view.timing]);

  /**
   * Demo modes, so nobody has to time a click:
   * - clientDropAfterTokens: the client aborts its own request mid-summary → fetch throws.
   * - serverDropAfterEvents: the server ends the stream cleanly (?drop_after=N) → no error at all, just
   *   a stream that finishes without `done`.
   * Both must be detected as a drop and resumed; they exercise different detection paths.
   */
  function start(
    e?: FormEvent,
    demo: { clientDropAfterTokens?: number; serverDropAfterEvents?: number; simulateLlm?: "overloaded" } = {},
    llmOverride?: LlmChoice,
  ) {
    e?.preventDefault();
    const useLlm = llmOverride ?? llm;
    if (useLlm.mode === "none") return;
    run.current?.abort.abort();
    dispatch({ type: "reset" });
    setErrorMsg(null);
    setNow(0);

    const abort = new AbortController();
    let tokens = 0;
    const url = `/api/overview?symbol=${encodeURIComponent(symbol.trim())}&lang=${lang}`;
    const stream = openResumableStream({
      url,
      headers: { ...llmHeaders(useLlm), ...(demo.simulateLlm && { "X-LLM-Simulate": demo.simulateLlm }) },
      firstUrl: demo.serverDropAfterEvents ? `${url}&drop_after=${demo.serverDropAfterEvents}` : undefined,
      signal: abort.signal,
      onEvent: (event, id) => {
        // Server offsets are measured from when the run starts, which is when `meta` is sent. Align the
        // client clock to it, so time spent connecting (or compiling the route in dev) isn't counted.
        if (event.type === "meta" && run.current && !run.current.aligned) {
          run.current.t0 = performance.now();
          run.current.aligned = true;
        }
        dispatch({ type: "event", event, id, at: elapsed() });
        if (event.type === "token" && ++tokens === demo.clientDropAfterTokens) stream.dropConnection();
      },
      onState: (s) => {
        setConn(s);
        dispatch({ type: "conn", state: s, at: elapsed() });
        if (s.kind === "reconnecting") dispatch({ type: "log", text: `connection lost (${s.reason}); retry #${s.attempt} in ${s.delayMs}ms` });
        if (s.kind === "open" && s.resumedFrom) dispatch({ type: "log", text: `reconnected, resuming after Last-Event-ID ${shortId(s.resumedFrom)}` });
        if (s.kind === "closed" && s.reason === "gave_up") setErrorMsg(s.detail ?? null);
        if (s.kind === "closed" && s.reason === "error" && s.status && s.detail) setErrorMsg(s.detail); // HTTP 4xx
        if (s.kind === "closed" && s.status === 401) setLlm({ mode: "none" }); // server needs a key: back to setup
      },
    });
    run.current = { abort, drop: stream.dropConnection, t0: performance.now(), aligned: false };
  }

  const asOf = Object.values(view.results).find((r) => r?.asOf)?.asOf;
  const retry = () => start();
  const retryInDemo = () => {
    setLlm({ mode: "demo" });
    start(undefined, {}, { mode: "demo" });
  };
  const demoProps = {
    t,
    streaming,
    canDrop: conn?.kind === "open",
    needsLlm: llm.mode === "none",
    onClientDemo: () => start(undefined, { clientDropAfterTokens: 3 }),
    onServerDemo: () => start(undefined, { serverDropAfterEvents: 8 }),
    onLlmDemo: () => start(undefined, { simulateLlm: "overloaded" }),
    onDrop: () => run.current?.drop(),
  };
  const summarizing = streaming && view.provider !== null && !view.timing;
  const needsLlm = llm.mode === "none";
  // Badge for whichever LLM wrote (or will write) this summary.
  const providerShown = view.provider ?? (llm.mode === "gemini" ? "gemini" : llm.mode === "demo" ? "demo" : null);
  const badge = providerShown?.startsWith("gemini") ? t.badgeGemini(GEMINI_MODEL_LABEL) : providerShown === "demo" ? t.badgeDemo : null;

  return (
    <>
      {/* 1. Toolbar stays pinned, so the controls are always reachable while you watch the page react. */}
      <header className="toolbar">
        <div className="toolbar-inner">
          <h1 title={t.sub}>{t.title}</h1>
          <form className="controls" onSubmit={(e) => start(e)}>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label={t.symbol} placeholder={t.symbol} />
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="Language">
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
            </select>
            {streaming ? (
              <button type="button" onClick={() => run.current?.abort.abort()}>
                {t.stop}
              </button>
            ) : (
              <button type="submit" className="primary" disabled={needsLlm} title={needsLlm ? t.needKey : undefined}>
                {t.get}
              </button>
            )}
          </form>
          <ConnectionBar conn={conn} runError={view.runError} t={t} />
          <LlmChip t={t} llm={llm} onChangeKey={() => setLlm({ mode: "none" })} onDemo={() => setLlm({ mode: "demo" })} />

          {/* Demo tools: inline on wide screens, folded into a 🧪 menu when the toolbar gets tight. */}
          <DemoTools variant="inline" {...demoProps} />
          <DemoTools variant="menu" {...demoProps} />
        </div>
      </header>

      {/* 2. Two columns: what the user reads on the left, how the run behaved on the right. */}
      <main className="dashboard">
        <div className="col-left">
          <section className="card summary-card">
            <div className="card-head">
              <h2>{t.summary}</h2>
              {badge && <span className={`llm-badge ${providerShown === "demo" ? "demo" : "gemini"}`}>{badge}</span>}
            </div>
            {view.sourceUrl && (
              <p className="source">
                {symbol.trim()} · {t.asOf} {asOf ?? "—"} ·{" "}
                <a href={view.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {t.source} ↗
                </a>
              </p>
            )}
            {needsLlm ? (
              <KeySetup t={t} onUseKey={(key) => setLlm({ mode: "gemini", key })} onDemo={() => setLlm({ mode: "demo" })} />
            ) : (
              <div className={`summary${view.runError && !view.summary ? " empty" : ""}`}>
                {!conn && <p className="hint">{llm.mode === "demo" ? t.readyDemoHint : t.readyHint}</p>}
                {renderMarkdown(view.summary)}
                {summarizing && <span className="cursor" />}
              </div>
            )}
            {view.runError && !needsLlm && (
              <RunErrorPanel
                err={view.runError}
                t={t}
                canUseDemo={llm.mode === "gemini"}
                onRetry={retry}
                onDemo={retryInDemo}
                onChangeKey={() => setLlm({ mode: "none" })}
              />
            )}
            {errorMsg && !needsLlm && <p className="error">{errorMsg}</p>}
          </section>

          <div className="grid">
            {AGENTS.map((name) => (
              <AgentCard key={name} title={t.agents[name]} result={view.results[name]} active={streaming} lang={lang} t={t} />
            ))}
          </div>
        </div>

        <div className="col-right">
          <Timeline
            data={{
              results: view.results,
              synthesisAt: view.synthesisAt,
              firstTokenMs: view.timing?.firstTokenMs ?? view.firstTokenAt,
              totalMs: view.timing?.totalMs ?? null,
              llmError:
                view.runError?.atMs !== undefined
                  ? { atMs: view.runError.atMs, code: view.runError.code, partial: !!view.runError.partial }
                  : null,
              conn: view.conn,
            }}
            live={now}
            streaming={streaming}
            t={t}
          />
          <EventLog log={view.log} t={t} />
        </div>
      </main>
    </>
  );
}

function DemoTools({
  variant,
  t,
  streaming,
  canDrop,
  needsLlm,
  onClientDemo,
  onServerDemo,
  onLlmDemo,
  onDrop,
}: {
  variant: "inline" | "menu";
  t: T;
  streaming: boolean;
  canDrop: boolean;
  needsLlm: boolean;
  onClientDemo: () => void;
  onServerDemo: () => void;
  onLlmDemo: () => void;
  onDrop: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // In the menu, an action closes it so the user can watch the result.
  const act = (fn: () => void) => () => {
    fn();
    if (menu.current) menu.current.open = false;
  };
  const items = [
    { label: t.demoClient, hint: needsLlm ? t.needKey : t.demoClientHint, onClick: onClientDemo, disabled: streaming || needsLlm, primary: true },
    { label: t.demoServer, hint: needsLlm ? t.needKey : t.demoServerHint, onClick: onServerDemo, disabled: streaming || needsLlm, primary: true },
    { label: t.demoLlm, short: t.demoLlmShort, hint: needsLlm ? t.needKey : t.demoLlmHint, onClick: onLlmDemo, disabled: streaming || needsLlm, primary: true },
    { label: t.drop, hint: t.dropHint, onClick: onDrop, disabled: !canDrop, primary: false },
  ];

  if (variant === "inline") {
    return (
      <div className="toolbar-demo" title={t.demoHint}>
        <span className="demo-label">{t.demo}</span>
        {items.map((it) => (
          <button key={it.label} type="button" className={it.primary ? "demo-run" : undefined} onClick={it.onClick} disabled={it.disabled} title={it.hint}>
            {"short" in it && it.short ? it.short : it.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <details className="demo-menu" ref={menu}>
      <summary aria-label={t.demo} title={t.demo}>
        🧪
      </summary>
      <div className="demo-pop">
        <strong>{t.demo}</strong>
        {items.map((it) => (
          <div key={it.label} className="demo-item">
            <button type="button" className={it.primary ? "demo-run" : undefined} onClick={act(it.onClick)} disabled={it.disabled}>
              {it.label}
            </button>
            <span className="hint">{it.hint}</span>
          </div>
        ))}
        <p className="hint">{t.demoHint}</p>
      </div>
    </details>
  );
}

/** What went wrong, what it means, and what to do about it. Agent data stays on screen regardless. */
function RunErrorPanel({
  err,
  t,
  canUseDemo,
  onRetry,
  onDemo,
  onChangeKey,
}: {
  err: RunError;
  t: T;
  canUseDemo: boolean;
  onRetry: () => void;
  onDemo: () => void;
  onChangeKey: () => void;
}) {
  const code = err.code ?? "llm_error";
  const llmFailure = code !== "agents_failed";
  return (
    <>
      {err.partial && <div className="partial-cut">⚠ {t.errCut}</div>}
      <div className="run-error" role="alert">
        <strong>⚠ {t.errTitle[code]}</strong>
        <p>{t.errBody[code]}</p>
        {err.simulated && <p className="hint">🧪 {t.errSimulated}</p>}
        <div className="run-error-actions">
          {err.retryable !== false && (
            <button type="button" className="primary" onClick={onRetry}>
              {err.partial ? t.regenerate : t.retry}
            </button>
          )}
          {code === "invalid_key" && (
            <button type="button" className="primary" onClick={onChangeKey}>
              {t.chipChange}
            </button>
          )}
          {llmFailure && code !== "invalid_key" && canUseDemo && (
            <button type="button" onClick={onDemo}>
              {t.useDemo}
            </button>
          )}
        </div>
        {llmFailure && <p className="hint">{t.errUnaffected}</p>}
      </div>
    </>
  );
}

/** 3. Always-visible event log that follows new entries, unless the reader has scrolled up to look at older ones. */
function EventLog({ log, t }: { log: View["log"]; t: T }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.length]);
  return (
    <section className="card log-card">
      <div className="card-head">
        <h2>{t.log}</h2>
        <span className="meta">{log.length}</span>
      </div>
      <div
        className="log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {log.length === 0 && <p className="hint">{t.demoHint}</p>}
        {log.map((l, i) => (
          <div key={i} className={l.sys ? "sys" : undefined}>
            {l.sys ? `⚠ ${l.text}` : l.text}
          </div>
        ))}
      </div>
    </section>
  );
}

function ConnectionBar({ conn, runError, t }: { conn: ConnectionState | null; runError: RunError | null; t: T }) {
  const [dot, text] = ((): [string, string] => {
    if (!conn) return ["", t.idle];
    switch (conn.kind) {
      case "connecting":
        return ["warn", t.connecting];
      case "open":
        return ["ok", conn.resumedFrom ? t.resumed : t.open];
      case "reconnecting":
        return ["warn", t.lost(conn.reason, conn.attempt, (conn.delayMs / 1000).toFixed(1))];
      case "closed":
        if (conn.reason === "done") return ["ok", t.complete];
        if (conn.reason === "aborted") return ["", t.stopped];
        if (conn.reason === "gave_up") return ["bad", t.gaveUp];
        // the connection was fine; the run itself failed: say why
        return ["bad", runError?.code ? t.statusFail[runError.code] : t.failed];
    }
  })();
  return (
    <div className="status" title={text}>
      <span className={`dot ${dot}`} />
      <span className="status-text">{text}</span>
    </div>
  );
}

function AgentCard({ title, result, active, lang, t }: { title: string; result?: AgentResult; active: boolean; lang: Lang; t: T }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {title}
          {result && <span className={`badge ${result.status}`}>{result.status}</span>}
        </h2>
        {result && <span className="meta">{result.latencyMs} ms</span>}
      </div>
      {!result && <p className="hint">{active ? t.retrieving : "—"}</p>}
      {result?.status === "error" && <p className="error">{result.error}</p>}
      {result && result.fields.length > 0 && (
        <table>
          <tbody>
            {result.fields.map((f) => (
              <tr key={f.key}>
                <td>{lang === "zh-TW" ? f.labelZh : f.label}</td>
                <td className={`num ${changeClass(f)}`}>{formatValue(f, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Taiwan market convention: red = up, green = down. */
function changeClass(f: Field): string {
  if (f.key !== "change" || f.value === null || f.value === 0) return "";
  return f.value > 0 ? "up" : "down";
}

function formatValue(f: Field, t: T): string {
  if (f.value === null) return "n/a";
  const n = f.value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (f.key === "change") return f.value > 0 ? `▲ ${n}` : f.value < 0 ? `▼ ${n.replace("-", "")}` : n;
  if (f.unit === "lots") return `${n} ${t.lots}`;
  if (f.unit === "%") return `${n}%`;
  return n;
}
