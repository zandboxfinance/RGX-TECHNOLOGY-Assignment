import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { renderMarkdown } from "@/lib/client/markdown";

const html = (md: string) => renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(md)));

describe("renderMarkdown", () => {
  it("renders paragraphs, bullet lists and bold", () => {
    expect(html("**台積電** 概況\n- 收盤 **2,500**\n• 本益比 28.98\n\n結論")).toBe(
      "<p><strong>台積電</strong> 概況</p><ul><li>收盤 <strong>2,500</strong></li><li>本益比 28.98</li></ul><p>結論</p>",
    );
  });

  it("keeps an unclosed ** literal while the stream is still arriving", () => {
    expect(html("收盤 **2,5")).toBe("<p>收盤 **2,5</p>");
  });

  it("never injects model output as HTML", () => {
    expect(html("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });
});
