/** Minimal SSE wire format helpers, shared by the server route and the browser client. */

export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

export function encodeSse(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Incremental parser: feed it arbitrary chunks (a message may be split across network reads)
 * and it calls `onMessage` once per complete message. Comment lines (": keep-alive") are skipped.
 */
export function createSseParser(onMessage: (m: SseMessage) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let id: string | undefined;
      let event = "message";
      const data: string[] = [];
      for (const line of part.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) onMessage({ id, event, data: data.join("\n") });
    }
  };
}

/** Event ids are "<streamId>:<seq>" so a single Last-Event-ID header is enough to resume. */
export function formatEventId(streamId: string, seq: number): string {
  return `${streamId}:${seq}`;
}

export function parseEventId(raw: string | null | undefined): { streamId: string; seq: number } | null {
  const m = raw?.match(/^([\w-]+):(\d+)$/);
  return m ? { streamId: m[1], seq: Number(m[2]) } : null;
}
