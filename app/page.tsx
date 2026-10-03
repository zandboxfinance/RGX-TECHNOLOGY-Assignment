"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { openResumableStream, type ConnectionState } from "@/lib/client/resumableStream";
import { renderMarkdown } from "@/lib/client/markdown";
import type { AgentName, AgentResult, Field, Lang, OverviewEvent } from "@/lib/types";
import { strings } from "./i18n";
import { Timeline, type ConnTrack } from "./Timeline";

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
      return { ...v, log };
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
  function start(e?: FormEvent, demo: { clientDropAfterTokens?: number; serverDropAfterEvents?: number } = {}) {
    e?.preventDefault();
    run.current?.abort.abort();
    dispatch({ type: "reset" });
    setErrorMsg(null);
    setNow(0);

    const abort = new AbortController();
    let tokens = 0;
    const url = `/api/overview?symbol=${encodeURIComponent(symbol.trim())}&lang=${lang}`;
    const stream = openResumableStream({
      url,
      firstUrl: demo.serverDropAfterEvents ? `${url}&drop_after=${demo.serverDropAfterEvents}` : undefined,
      signal: abort.signal,
      onEvent: (event, id) => {
        // Server offsets are measured from when the run starts, which is when `meta` is sent. Align the
        // client clock to it, so time spent connecting (or compiling the route in dev) isn't counted.
        if (event.type === "meta" && run.current && !run.current.aligned) {
          run.current.t0 = performance.now();
          run.current.aligned = true;
        }
        if (event.type === "error") setErrorMsg(event.data.message);
        dispatch({ type: "event", event, id, at: elapsed() });
        if (event.type === "token" && ++tokens === demo.clientDropAfterTokens) stream.dropConnection();
      },
      onState: (s) => {
        setConn(s);
        dispatch({ type: "conn", state: s, at: elapsed() });
        if (s.kind === "reconnecting") dispatch({ type: "log", text: `connection lost (${s.reason}); retry #${s.attempt} in ${s.delayMs}ms` });
        if (s.kind === "open" && s.resumedFrom) dispatch({ type: "log", text: `reconnected, resuming after Last-Event-ID ${shortId(s.resumedFrom)}` });
        if (s.kind === "closed" && s.reason === "gave_up") setErrorMsg(s.detail ?? null);
        if (s.kind === "closed" && s.reason === "error" && s.detail) setErrorMsg(s.detail);
      },
    });
    run.current = { abort, drop: stream.dropConnection, t0: performance.now(), aligned: false };
  }

  const asOf = Object.values(view.results).find((r) => r?.asOf)?.asOf;
  const demoProps = {
    t,
    streaming,
    canDrop: conn?.kind === "open",
    onClientDemo: () => start(undefined, { clientDropAfterTokens: 3 }),
    onServerDemo: () => start(undefined, { serverDropAfterEvents: 8 }),
    onDrop: () => run.current?.drop(),
  };
  const summarizing = streaming && view.provider !== null && !view.timing;

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
              <button type="submit" className="primary">
                {t.get}
              </button>
            )}
          </form>
          <ConnectionBar conn={conn} t={t} />

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
              {view.provider && <span className="meta">{view.provider}</span>}
            </div>
            {view.sourceUrl && (
              <p className="source">
                {symbol.trim()} · {t.asOf} {asOf ?? "—"} ·{" "}
                <a href={view.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {t.source} ↗
                </a>
              </p>
            )}
            <div className="summary">
              {!conn && <p className="hint">{t.sub}</p>}
              {renderMarkdown(view.summary)}
              {summarizing && <span className="cursor" />}
            </div>
            {errorMsg && <p className="error">{errorMsg}</p>}
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
  onClientDemo,
  onServerDemo,
  onDrop,
}: {
  variant: "inline" | "menu";
  t: T;
  streaming: boolean;
  canDrop: boolean;
  onClientDemo: () => void;
  onServerDemo: () => void;
  onDrop: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // In the menu, an action closes it so the user can watch the result.
  const act = (fn: () => void) => () => {
    fn();
    if (menu.current) menu.current.open = false;
  };
  const items = [
    { label: t.demoClient, hint: t.demoClientHint, onClick: onClientDemo, disabled: streaming, primary: true },
    { label: t.demoServer, hint: t.demoServerHint, onClick: onServerDemo, disabled: streaming, primary: true },
    { label: t.drop, hint: t.dropHint, onClick: onDrop, disabled: !canDrop, primary: false },
  ];

  if (variant === "inline") {
    return (
      <div className="toolbar-demo" title={t.demoHint}>
        <span className="demo-label">{t.demo}</span>
        {items.map((it) => (
          <button key={it.label} type="button" className={it.primary ? "demo-run" : undefined} onClick={it.onClick} disabled={it.disabled} title={it.hint}>
            {it.label}
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

function ConnectionBar({ conn, t }: { conn: ConnectionState | null; t: T }) {
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
        return ["bad", conn.reason === "gave_up" ? t.gaveUp : t.failed];
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
