export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "heading"; spans: Span[] }
  | { kind: "bullet"; marker: string; spans: Span[] };

const HEADING = /^#{1,6}\s+(.*)$/;
const UNORDERED = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const EMPHASIS = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3/g;

// Agents answer in markdown even when asked not to, and a chat bubble that
// prints `**140g**` verbatim reads as a bug to the user. Parsing is the fix
// rather than stripping: bold carries the number the answer is about.
function parseSpans(text: string): Span[] {
  const plain = text.replace(/`([^`]+)`/g, "$1");
  const spans: Span[] = [];
  let cursor = 0;
  for (const match of plain.matchAll(EMPHASIS)) {
    const at = match.index ?? 0;
    if (at > cursor) spans.push({ text: plain.slice(cursor, at) });
    spans.push(match[2] ? { text: match[2], bold: true } : { text: match[4], italic: true });
    cursor = at + match[0].length;
  }
  if (cursor < plain.length) spans.push({ text: plain.slice(cursor) });
  return spans.length > 0 ? spans : [{ text: plain }];
}

// Turns an agent's markdown-ish prose into blocks the bubble can lay out.
// Deliberately small: emphasis, bullets, headings and flattened tables are
// everything the coach and planner actually emit.
export function parseCoachText(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseSpans(paragraph.join(" ")) });
    paragraph = [];
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("|")) {
      flush();
      if (TABLE_RULE.test(line)) continue;
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell !== "");
      if (cells.length > 0) blocks.push({ kind: "paragraph", spans: parseSpans(cells.join(" · ")) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", spans: parseSpans(heading[1]) });
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      flush();
      blocks.push({ kind: "bullet", marker: `${ordered[1]}.`, spans: parseSpans(ordered[2]) });
      continue;
    }
    const unordered = UNORDERED.exec(line);
    if (unordered) {
      flush();
      blocks.push({ kind: "bullet", marker: "•", spans: parseSpans(unordered[1]) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
