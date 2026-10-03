# Take-Home Task: Multi-Agent Retrieval with Streaming Output

## The Problem

We want to show a user a fast, synthesized answer when they ask about a stock — e.g. **"Give me a quick overview of TSMC (2330) right now."**

The data lives on one page: [Fubon eBroker — TSMC (2330)](https://fubon-ebrokerdj.fbs.com.tw/Z/ZC/ZCX/ZCX_2330.djhtm), which contains three independent blocks:

- **Price**: open/high/low/close, volume, 52-week high/low
- **Valuation**: P/E ratio, industry-average P/E, market cap, price-to-book ratio
- **Financial health**: book value per share, debt ratio, beta, standard deviation, returns (YTD/1-week/1-month/3-month)

## What to Build

A backend service with 3 agents, each retrieving one block above:

- **Agent A** — Price
- **Agent B** — Valuation
- **Agent C** — Financial health

A and B/C don't depend on each other, so:

1. **Parallel execution** — the agents run concurrently, not sequentially.
2. **Streaming synthesis** — once the agents return, a final step calls an LLM (your choice, free tier) to synthesize their output into a short summary, streamed back via SSE or WebSocket so the first token appears quickly rather than waiting for the full summary.
3. **Basic disconnect handling** — if the connection drops mid-stream, the client (a simple script or minimal frontend is fine) detects it and indicates a reconnect attempt. No full heartbeat system needed — just show you've thought about the failure case.
4. **A short README** — your architecture decisions, trade-offs, and any assumptions about the page's structure (it may change — that's fine, just document what you assumed).

## Not Required

Account/auth, CI/CD, real deployment, rollback — we'll cover those in conversation, not here.

## Timeline & Delivery

~2 days. Public GitHub repo.

Questions welcome.
