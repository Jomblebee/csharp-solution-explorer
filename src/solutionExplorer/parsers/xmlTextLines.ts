// A text model for editing project files without an XML DOM: the original string, a masked copy for
// matching, and line offsets for the places an edit has to be line-aware.
//
// Two decisions shape this:
//
// Edits are offset-based, not line-rebuild-based. Replacing a substring leaves every byte outside it
// untouched — indentation, attribute spacing, trailing comments and mixed line endings all survive by
// construction, rather than by a writer remembering to preserve them.
//
// Matching runs against a masked copy where comment and CDATA interiors are blanked out with spaces
// of the *same length*, so every offset in the mask is also valid in the original. That is what stops
// a commented-out `<!-- <Nullable>enable</Nullable> -->` from being read as a declaration.

export interface TextRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface XmlTextModel {
  text: string;
  /** Same length as `text`, with comment and CDATA interiors blanked. Match against this. */
  masked: string;
  /** The file's dominant line ending, for text this module inserts. */
  newline: string;
  /** Offset of the first character of each line. */
  lineStarts: number[];
  /** CDATA sections, so an edit can refuse to touch a value that lives inside one. */
  cdata: TextRange[];
}

export function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function leadingIndent(line: string): string {
  return /^([ \t]*)/.exec(line)?.[1] ?? "";
}

export function buildXmlTextModel(text: string): XmlTextModel {
  const { masked, cdata } = maskCommentsAndCdata(text);
  return { text, masked, newline: detectNewline(text), lineStarts: computeLineStarts(text), cdata };
}

/** The 0-based line containing `offset`. */
export function lineIndexAt(model: XmlTextModel, offset: number): number {
  // Binary search: project files are small, but this runs per occurrence per property.
  let low = 0;
  let high = model.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (model.lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** The line's extent, excluding its line terminator. */
export function lineRange(model: XmlTextModel, index: number): TextRange {
  const start = model.lineStarts[index];
  const nextStart = index + 1 < model.lineStarts.length ? model.lineStarts[index + 1] : model.text.length;
  let end = nextStart;
  while (end > start && (model.text[end - 1] === "\n" || model.text[end - 1] === "\r")) {
    end--;
  }
  return { start, end };
}

export function lineText(model: XmlTextModel, index: number): string {
  const range = lineRange(model, index);
  return model.text.slice(range.start, range.end);
}

/** The offset just past the line's terminator, i.e. where the next line begins. */
export function lineEndWithTerminator(model: XmlTextModel, index: number): number {
  return index + 1 < model.lineStarts.length ? model.lineStarts[index + 1] : model.text.length;
}

export function overlapsAny(ranges: readonly TextRange[], range: TextRange): boolean {
  return ranges.some((candidate) => candidate.start < range.end && range.start < candidate.end);
}

/**
 * Applies non-overlapping replacements to the model's text. Sorted and applied back-to-front so each
 * range's offsets still refer to the original string when its turn comes.
 */
export function applyEdits(text: string, edits: readonly { range: TextRange; replacement: string }[]): string {
  const ordered = [...edits].sort((a, b) => b.range.start - a.range.start);
  let result = text;
  for (const edit of ordered) {
    result = result.slice(0, edit.range.start) + edit.replacement + result.slice(edit.range.end);
  }
  return result;
}

/**
 * The single range that turns `before` into `after`, found by trimming the common prefix and suffix.
 *
 * This is what lets an edit reach an open editor as a small replacement rather than a whole-document
 * rewrite: a tight range keeps the caret, the scroll position and the undo entry meaningful. Returns
 * `undefined` when the texts are identical.
 */
export function diffRange(
  before: string,
  after: string,
): { range: TextRange; replacement: string } | undefined {
  if (before === after) {
    return undefined;
  }
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) {
    start++;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  return { range: { start, end: beforeEnd }, replacement: after.slice(start, afterEnd) };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Blanks the interiors of comments and CDATA sections, keeping every offset — and every line break —
 * where it was. The delimiters themselves stay, so a masked comment still cannot be mistaken for
 * markup.
 */
function maskCommentsAndCdata(text: string): { masked: string; cdata: TextRange[] } {
  // split("") and not [...text]: the spread iterates code points, which would shift every offset
  // after an emoji or other non-BMP character in a comment.
  const chars = text.split("");
  const cdata: TextRange[] = [];

  blank(chars, text, "<!--", "-->");
  for (const range of blank(chars, text, "<![CDATA[", "]]>")) {
    cdata.push(range);
  }

  return { masked: chars.join(""), cdata };
}

/** Blanks each `open`…`close` interior in place, returning the full ranges including delimiters. */
function blank(chars: string[], text: string, open: string, close: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = text.indexOf(open);
  while (index !== -1) {
    const closeIndex = text.indexOf(close, index + open.length);
    // An unterminated comment runs to the end of the file — mask the rest, since none of it is markup.
    const end = closeIndex === -1 ? text.length : closeIndex + close.length;
    for (let i = index + open.length; i < (closeIndex === -1 ? text.length : closeIndex); i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") {
        chars[i] = " ";
      }
    }
    ranges.push({ start: index, end });
    if (closeIndex === -1) {
      break;
    }
    index = text.indexOf(open, end);
  }
  return ranges;
}
