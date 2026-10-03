"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentName, AgentResult, Lang, RunError } from "@/lib/types";
import { strings } from "./i18n";

type T = (typeof strings)[Lang];
const AGENTS: AgentName[] = ["price", "valuation", "financial"];

export interface ConnTrack {
  segments: { from: number; to: number | null }[];
  drops: { at: number; reason: string }[];
  resumes: { at: number; seq: string }[];
}

export interface TimelineData {
  results: Partial<Record<AgentName, AgentResult>>;
  /** All times below are ms offsets from the start of the run (server clock). */
  synthesisAt: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  /** The run failed at `atMs` (server clock): the LLM row ends there with ✕ instead of freezing. */
  llmError: { atMs: number; code?: RunError["code"]; partial: boolean } | null;
  conn: ConnTrack;
}

// Share of the track width given to the agent phase, and to the axis break between the phases.
const PHASE1 = 0.3;
const GAP = 0.035;

/**
 * Waterfall of one run. The agent phase (~100 ms) and the LLM phase (seconds) differ by an order of
 * magnitude, so a single linear axis would squash the agents into slivers and hide the overlap the
 * chart exists to show. The axis is therefore split: each phase gets its own linear scale, with a
 * visible break (≈) between them.
 */
export function Timeline({ data, live, streaming, t }: { data: TimelineData; live: number; streaming: boolean; t: T }) {
  const results = AGENTS.map((a) => data.results[a]);
  const agentEnd = Math.max(1, ...results.map((r) => (r ? r.startMs + r.latencyMs : 0)));
  const split = data.synthesisAt ?? Math.max(agentEnd, streaming ? live : 0);
  // When the run ended: `done`, or the failure time from the server, or (still running) now.
  const finishedAt = data.totalMs ?? data.llmError?.atMs ?? null;
  const end = data.synthesisAt === null ? split : Math.max(finishedAt ?? live, split + 1);
  const twoPhase = end > split;

  const x = (ms: number) => {
    const t = Math.max(0, ms);
    if (!twoPhase || t <= split) return (Math.min(t, split) / Math.max(split, 1)) * (twoPhase ? PHASE1 : 1);
    return PHASE1 + GAP + ((Math.min(t, end) - split) / (end - split)) * (1 - PHASE1 - GAP);
  };
  const span = (from: number, to: number) => ({ left: pct(x(from)), width: pct(Math.max(x(to) - x(from), 0.004)) });

  // Tick density follows the track's real width, so labels don't collide in a narrow column or on a phone.
  const axis = useRef<HTMLDivElement>(null);
  const trackPx = useWidth(axis);
  const minGap = Math.max(0.06, 56 / trackPx);
  const phase1Ticks = twoPhase && PHASE1 * trackPx < 110 ? [0] : niceTicks(0, split, 2);
  const ticks = [
    ...phase1Ticks.map((v) => ({ v, at: x(v) })),
    ...(twoPhase ? niceTicks(split, end, 4).filter((v) => v > split).map((v) => ({ v, at: x(v) })) : []),
  ].filter((tk, i, arr) => i === 0 || tk.at - arr[i - 1].at > minGap);

  // Tap / click a row to pin its details below the chart (hover tooltips don't exist on touch screens).
  const [picked, setPicked] = useState<string | null>(null);
  const pick = (key: string) => setPicked((p) => (p === key ? null : key));
  const tips: Record<string, { label: string; text: string }> = {};
  const row = (key: string, label: string, text: string | undefined) => {
    if (text) tips[key] = { label, text };
    return { id: key, label, title: text, picked: picked === key, onPick: text ? pick : undefined };
  };

  const idle = !streaming && results.every((r) => !r);
  const upstream = upstreamSummary(results, t);
  const firstToken = data.firstTokenMs;
  const llmEnd = finishedAt ?? live;
  const failed = data.llmError !== null && data.synthesisAt !== null;
  const errTitle = data.llmError?.code ? t.errTitle[data.llmError.code] : t.tlFailed;

  return (
    <section className="card timeline-card">
      <div className="card-head">
        <h2>{t.timeline}</h2>
        {failed && (
          <span className="meta bad">
            {t.tlLlmFailed(fmt(llmEnd))}
            {firstToken !== null && ` · ${t.firstToken} ${fmt(firstToken)}`}
          </span>
        )}
        {data.totalMs !== null && (
          <span className="meta">
            {t.firstToken} {firstToken !== null ? fmt(firstToken) : "—"} · {t.total} {fmt(data.totalMs)}
          </span>
        )}
      </div>
      <p className="hint">{t.timelineHint}</p>

      <div className="timeline">
        <Row id="axis" label="" value="" gap={false}>
          <div className="tl-axis" ref={axis} hidden={idle}>
            {ticks.map((tk) => (
              <span key={tk.v} className="tl-tick" style={{ left: pct(tk.at) }}>
                {fmt(tk.v)}
              </span>
            ))}
            {twoPhase && <span className="tl-break-label" style={{ left: pct(PHASE1 + GAP / 2) }}>≈</span>}
          </div>
        </Row>

        <Row gap={twoPhase} {...row("upstream", t.upstream, upstream.detail)} value={upstream.value}>
          {upstream.bar && (
            <div className="tl-bar fetch" style={span(upstream.bar.from, upstream.bar.to)} title={upstream.detail} />
          )}
          {upstream.text && (
            <span className={`tl-inline${upstream.bar ? "" : " left"}`}>
              <span className="tl-inline-long">{upstream.text}</span>
              <span className="tl-inline-short">{upstream.short}</span>
            </span>
          )}
        </Row>

        {AGENTS.map((name, i) => {
          const r = results[i];
          if (!r) {
            return (
              <Row gap={twoPhase} key={name} {...row(name, t.short[name], undefined)} value={streaming ? "…" : "—"}>
                {streaming && live > 0 && <div className="tl-bar pending" style={span(0, Math.min(live, split))} />}
              </Row>
            );
          }
          const agentEndMs = r.startMs + r.latencyMs;
          const waitedOnNetwork = r.fetch && r.fetch.origin !== "cache" && r.status !== "error";
          const fetchDone = waitedOnNetwork ? Math.min(Math.max(r.fetch!.endMs, r.startMs), agentEndMs) : r.startMs;
          const tip = [
            `${fmt(r.startMs)} → ${fmt(agentEndMs)} (${fmt(r.latencyMs)})`,
            r.fetch && `${t.origin[r.fetch.origin]}${waitedOnNetwork ? `, ${t.waitFetch} ${fmt(fetchDone - r.startMs)}` : ""}`,
            r.status !== "error" && `${t.parse} ${fmt(agentEndMs - fetchDone)}`,
            r.error,
          ]
            .filter(Boolean)
            .join("\n");
          return (
            <Row gap={twoPhase} key={name} {...row(name, t.agents[name], tip)} label={t.short[name]} value={fmt(r.latencyMs)}>
              {waitedOnNetwork && fetchDone > r.startMs && <div className="tl-bar wait" style={span(r.startMs, fetchDone)} title={tip} />}
              <div className={`tl-bar ${r.status}`} style={span(fetchDone, agentEndMs)} title={tip} />
            </Row>
          );
        })}

        <Row
          gap={twoPhase}
          {...row(
            "llm",
            t.llm,
            data.synthesisAt !== null
              ? [
                  `${t.ttftWait} ${firstToken !== null ? fmt(firstToken - data.synthesisAt) : failed ? "—" : "…"}`,
                  firstToken !== null && `${t.streamingOut} ${fmt(llmEnd - firstToken)}`,
                  failed && `✕ ${t.tlFailedAt(fmt(llmEnd))}: ${errTitle}`,
                  failed && data.llmError!.partial && t.tlPartial,
                ]
                  .filter(Boolean)
                  .join("\n")
              : undefined,
          )}
          value={
            data.synthesisAt === null
              ? data.llmError
                ? t.tlSkipped // e.g. every agent failed, so there was nothing to summarize
                : streaming
                  ? t.waiting
                  : "—"
              : failed
                ? t.tlFailed
                : fmt(llmEnd - data.synthesisAt)
          }
        >
          {data.synthesisAt !== null && (
            <>
              <div
                className={`tl-bar wait llm${failed && firstToken === null ? " failed" : ""}`}
                style={span(data.synthesisAt, firstToken ?? llmEnd)}
              />
              {firstToken !== null && (
                <div className={`tl-bar llm ${finishedAt === null ? "live" : ""}`} style={span(firstToken, llmEnd)} />
              )}
              {failed && (
                <span className="tl-pin fail" style={{ left: pct(x(llmEnd)) }} title={errTitle}>
                  ✕
                </span>
              )}
            </>
          )}
          {firstToken !== null && (
            <span className="tl-marker" style={{ left: pct(x(firstToken)) }}>
              ▲ <span className="tl-marker-text">{t.firstToken} </span>
              {fmt(firstToken)}
            </span>
          )}
        </Row>

        <ClientRow
          conn={data.conn}
          live={live}
          end={finishedAt}
          span={span}
          x={x}
          gap={twoPhase}
          t={t}
          row={row("client", t.client, clientTip(data.conn, t))}
        />
      </div>

      {picked && tips[picked] && (
        <div className="tl-detail" role="status">
          <strong>{tips[picked].label}</strong>
          <span>{tips[picked].text}</span>
          <button type="button" className="tl-detail-close" onClick={() => setPicked(null)} aria-label="close">
            ×
          </button>
        </div>
      )}

      <div className="tl-legend">
        <span><i className="sw wait" />{t.legendWait}</span>
        <span><i className="sw ok" />{t.legendWork}</span>
        <span><i className="sw llm" />{t.legendStream}</span>
        <span><i className="sw drop" />{t.legendDrop}</span>
        <span><i className="sw fail">✕</i>{t.legendFail}</span>
      </div>
    </section>
  );
}

function ClientRow({
  conn,
  live,
  end,
  span,
  x,
  gap,
  t,
  row,
}: {
  gap: boolean;
  row: RowIdentity;
  conn: ConnTrack;
  live: number;
  end: number | null;
  span: (a: number, b: number) => { left: string; width: string };
  x: (ms: number) => number;
  t: T;
}) {
  const close = (to: number | null) => Math.min(to ?? live, end ?? Infinity);
  const gaps = conn.drops.map((d) => {
    const back = conn.resumes.find((r) => r.at >= d.at);
    return { from: d.at, to: back ? back.at : live, reason: d.reason };
  });
  return (
    <Row gap={gap} {...row} value={t.drops(conn.drops.length)}>
      {conn.segments.map((s, i) => (
        <div key={`s${i}`} className="tl-bar conn" style={span(s.from, close(s.to))} />
      ))}
      {gaps.map((g, i) => (
        <div key={`g${i}`} className="tl-bar drop" style={span(g.from, g.to)} title={`${t.dropAt} ${fmt(g.from)}: ${g.reason}`} />
      ))}
      {conn.drops.map((d, i) => (
        <span key={`d${i}`} className="tl-pin drop" style={{ left: pct(x(d.at)) }} title={d.reason}>
          ✕
        </span>
      ))}
      {conn.resumes.map((r, i) => (
        <span key={`r${i}`} className="tl-pin resume" style={{ left: pct(x(r.at)) }} title={`${t.resumeAt} #${r.seq}`}>
          ↻ #{r.seq}
        </span>
      ))}
    </Row>
  );
}

interface RowIdentity {
  id: string;
  label: string;
  title?: string;
  picked?: boolean;
  onPick?: (id: string) => void;
}

function Row({
  id,
  label,
  value,
  title,
  picked,
  onPick,
  gap,
  children,
}: RowIdentity & {
  value: string;
  /** Draw the axis break (only once there are two phases to separate). */
  gap: boolean;
  children: ReactNode;
}) {
  const interactive = onPick
    ? {
        role: "button",
        tabIndex: 0,
        "aria-pressed": picked,
        onClick: () => onPick(id),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPick(id);
          }
        },
      }
    : {};
  return (
    <div className={`tl-row${onPick ? " pickable" : ""}${picked ? " picked" : ""}`} title={title} {...interactive}>
      <span className="tl-label">{label}</span>
      <div className={label ? "tl-track" : "tl-track bare"}>
        {gap && <div className="tl-break" style={{ left: pct(PHASE1), width: pct(GAP) }} />}
        {children}
      </div>
      <span className="tl-value">{value}</span>
    </div>
  );
}

/** One row describing the upstream request(s) the agents actually waited on (single-flight / cache). */
function upstreamSummary(results: (AgentResult | undefined)[], t: T) {
  const fetched = results.filter((r): r is AgentResult & { fetch: NonNullable<AgentResult["fetch"]> } => !!r?.fetch);
  const network = fetched.find((r) => r.fetch.origin === "network");
  if (network) {
    const f = network.fetch;
    const sharers = fetched.filter((r) => r.fetch.startMs === f.startMs && r.fetch.origin !== "cache").length;
    const retried = f.attempts > 1 ? ` · ${t.retried}` : "";
    return {
      bar: { from: f.startMs, to: f.endMs },
      value: fmt(f.endMs - f.startMs),
      detail: `${t.reqShared(sharers)}${retried}`,
      text: `${t.reqShared(sharers)}${retried}`,
      short: t.reqSharedShort(sharers),
    };
  }
  if (fetched.length && fetched.every((r) => r.fetch.origin === "cache")) {
    // Cached fetch times are offsets before this run started, so -endMs is the page's age.
    const ageSec = Math.max(0, Math.round(-fetched[0].fetch.endMs / 1000));
    return { bar: null, value: t.cacheValue, detail: t.cacheHit(ageSec), text: t.cacheHit(ageSec), short: t.cacheShort };
  }
  return { bar: null, value: "—", detail: "", text: "", short: "" };
}

function clientTip(conn: ConnTrack, t: T): string | undefined {
  if (!conn.segments.length) return undefined;
  if (!conn.drops.length) return t.drops(0);
  return conn.drops
    .map((d, i) => {
      const back = conn.resumes.find((r) => r.at >= d.at);
      return `✕ ${t.dropAt} ${fmt(d.at)} (${d.reason})${back ? ` → ↻ ${fmt(back.at)}, ${t.resumeAt} #${back.seq}` : ""}`;
    })
    .join("\n");
}

/** Width of an element in px, kept up to date with a ResizeObserver (ignores 0 while it is hidden). */
function useWidth(ref: RefObject<HTMLElement | null>, fallback = 400): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setW(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v));
  return min === 0 && out[0] !== 0 ? [0, ...out] : out;
}

const pct = (f: number) => `${(Math.min(Math.max(f, 0), 1) * 100).toFixed(2)}%`;
const fmt = (ms: number) => (Math.abs(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
