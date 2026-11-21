// Structure-aware chunking. Pure TypeScript, no imports.
//
// Policies and SOPs are already organised by numbered sections, and a question
// usually maps to one section. So we split on headings first and only split a
// section further when it is longer than the token budget. Each chunk is prefixed
// with "Document > Section" so it still makes sense on its own when retrieved.

export interface Section {
  heading: string | null;
  text: string;
}

export interface Chunk {
  chunk_index: number;
  heading: string | null;
  content: string; // includes the context prefix
  token_count: number;
}

export interface ChunkOptions {
  maxTokens?: number; // default 500
  overlapTokens?: number; // default 50
}

/** Rough token estimate (~0.75 words per token for English). Good enough for budgeting. */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();

/**
 * DOCX: pass the XML of word/document.xml (the caller unzips the file).
 * Paragraphs styled Heading1-3 (or Title) start sections; other paragraphs are text.
 * A tiny reader instead of a library: mammoth relies on Object.prototype.__proto__,
 * which Supabase's Deno runtime disables.
 */
export function docxXmlToSections(xml: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: null, text: "" };
  for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const body = p[0];
    const style = body.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
    const text = decode([...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map((m) => (m[1] !== undefined ? m[1] : " ")).join(""));
    if (!text) continue;
    const isList = /<w:numPr>/.test(body) || /List/i.test(style);
    if (/^(Heading[1-3]|Title)$/i.test(style)) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = { heading: text, text: "" };
    } else {
      current.text += (isList ? "• " : "") + text + "\n";
    }
  }
  if (current.text.trim() || current.heading) sections.push(current);
  return sections.filter((s) => s.text.trim());
}

/**
 * PDF text (one line per visual line): a heading is a short line that does not end
 * like a sentence and follows a line that did (or is numbered like "2. Slots").
 */
export function textToSections(text: string): Section[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections: Section[] = [];
  let current: Section = { heading: null, text: "" };
  lines.forEach((line, i) => {
    const prev = lines[i - 1] ?? "";
    const numbered = /^\d+(\.\d+)*\.?\s+[A-Z]/.test(line) && line.length <= 70 && !/[.;:]$/.test(line);
    const looksLikeHeading = line.length <= 60 && /^[A-Z0-9]/.test(line) && !/[.,;:]$/.test(line) &&
      (i === 0 || /[.)]$/.test(prev)) && i < lines.length - 1;
    if (numbered || looksLikeHeading) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = { heading: line, text: "" };
    } else {
      current.text += line + (/[.:]$/.test(line) ? "\n" : " ");
    }
  });
  if (current.text.trim() || current.heading) sections.push(current);
  return sections.filter((s) => s.text.trim());
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function chunkSections(title: string, sections: Section[], opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxTokens ?? 500, overlap = opts.overlapTokens ?? 50;
  const chunks: Chunk[] = [];
  const push = (heading: string | null, body: string) => {
    const prefix = `Document: ${title}${heading ? ` > Section: ${heading}` : ""}\n`;
    const content = prefix + body.trim();
    chunks.push({ chunk_index: chunks.length, heading, content, token_count: estimateTokens(content) });
  };
  for (const s of sections) {
    if (estimateTokens(s.text) <= max) { push(s.heading, s.text); continue; }
    // Long section: pack sentences up to the budget, carrying ~overlap tokens forward.
    let buf: string[] = [];
    for (const sentence of splitSentences(s.text)) {
      if (buf.length && estimateTokens([...buf, sentence].join(" ")) > max) {
        push(s.heading, buf.join(" "));
        const carry: string[] = [];
        for (let i = buf.length - 1; i >= 0 && estimateTokens(carry.join(" ")) < overlap; i--) carry.unshift(buf[i]);
        buf = carry;
      }
      buf.push(sentence);
    }
    if (buf.length) push(s.heading, buf.join(" "));
  }
  return chunks;
}
