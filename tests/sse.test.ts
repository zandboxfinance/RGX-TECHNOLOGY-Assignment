import { describe, expect, it } from "vitest";
import { createSseParser, encodeSse, parseEventId, type SseMessage } from "@/lib/sse";

describe("SSE codec", () => {
  it("round-trips messages even when split at arbitrary byte boundaries", () => {
    const wire =
      encodeSse("s:1", "token", { text: "台積電\n第一行" }) +
      ": keep-alive\n\n" +
      encodeSse("s:2", "done", { totalMs: 5 });
    for (let cut = 1; cut < wire.length; cut++) {
      const got: SseMessage[] = [];
      const feed = createSseParser((m) => got.push(m));
      feed(wire.slice(0, cut));
      feed(wire.slice(cut));
      expect(got).toEqual([
        { id: "s:1", event: "token", data: JSON.stringify({ text: "台積電\n第一行" }) },
        { id: "s:2", event: "done", data: JSON.stringify({ totalMs: 5 }) },
      ]);
    }
  });

  it("parses resume ids", () => {
    expect(parseEventId("3f2a-9c:17")).toEqual({ streamId: "3f2a-9c", seq: 17 });
    expect(parseEventId("garbage")).toBeNull();
    expect(parseEventId(null)).toBeNull();
  });
});
