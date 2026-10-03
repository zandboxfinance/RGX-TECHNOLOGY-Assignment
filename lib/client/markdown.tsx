import type { ReactNode } from "react";

/**
 * Tiny renderer for the subset of Markdown LLMs put in short summaries: paragraphs, bullet lists
 * ("- ", "* ", "• "), headings and **bold**. Builds React elements, so model output is never
 * injected as HTML. Works on partial text while streaming: an unclosed "**" stays literal until
 * its closing pair arrives.
 */
export function renderMarkdown(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`}>{list}</ul>);
    list = [];
  };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      list.push(<li key={i}>{inline(bullet[1])}</li>);
      return;
    }
    flush();
    if (!line) return;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    blocks.push(<p key={i}>{heading ? <strong>{inline(heading[1])}</strong> : inline(line)}</p>);
  });
  flush();
  return blocks;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}
