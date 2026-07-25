// Turns a Cobertura coverage report (`coverage.cobertura.xml`, produced by "XPlat Code Coverage" for
// VSTest and `--coverage-output-format cobertura` for MTP) into per-file line-hit data. Pure and
// vscode-free so it stays unit-testable, and regex-based rather than a full XML parse — same rationale
// and fail-open contract as trxParser.ts (unparseable input yields `[]`, never throws). We model only
// statement (line) coverage; branch/condition data is intentionally ignored for now.

export interface LineHit {
  line: number;
  hits: number;
}

export interface FileCoverageData {
  /** The source file path exactly as written in the report (may be absolute or project-relative). */
  file: string;
  lines: LineHit[];
}

/** Parses a Cobertura document into per-file line hits. Never throws; returns `[]` for bad input. */
export function parseCobertura(xml: string): FileCoverageData[] {
  // A file can be split across several <class> elements (partial classes, multiple classes per file),
  // so accumulate by filename and keep the highest hit count seen for any given line.
  const byFile = new Map<string, Map<number, number>>();

  const classPattern = /<class\b([^>]*)>([\s\S]*?)<\/class>/gi;
  for (const cls of xml.matchAll(classPattern)) {
    const filename = getAttr(cls[1], "filename");
    if (!filename) {
      continue;
    }
    let lines = byFile.get(filename);
    if (!lines) {
      lines = new Map<number, number>();
      byFile.set(filename, lines);
    }
    // <line number="10" hits="3" .../> — self-closing or with a nested <conditions> block.
    const linePattern = /<line\b([^>]*?)(?:\/>|>[\s\S]*?<\/line>)/gi;
    for (const ln of cls[2].matchAll(linePattern)) {
      const number = toInt(getAttr(ln[1], "number"));
      const hits = toInt(getAttr(ln[1], "hits"));
      if (number === undefined || hits === undefined) {
        continue;
      }
      const existing = lines.get(number);
      lines.set(number, existing === undefined ? hits : Math.max(existing, hits));
    }
  }

  const result: FileCoverageData[] = [];
  for (const [file, lines] of byFile) {
    result.push({ file, lines: sortedHits(lines) });
  }
  return result;
}

/**
 * Combines two sets of line hits for the *same* file, keeping the highest count per line. Needed
 * because one file can be covered by several reports — two test projects exercising the same
 * library each produce their own — and taking the last one seen would throw away the other's hits.
 * Same rule `parseCobertura` applies to several `<class>` elements within one document.
 */
export function mergeLineHits(a: readonly LineHit[], b: readonly LineHit[]): LineHit[] {
  const merged = new Map<number, number>();
  for (const { line, hits } of [...a, ...b]) {
    const existing = merged.get(line);
    merged.set(line, existing === undefined ? hits : Math.max(existing, hits));
  }
  return sortedHits(merged);
}

/** Line → hits as a line-ordered array. */
function sortedHits(lines: Map<number, number>): LineHit[] {
  return [...lines.entries()].map(([line, hits]) => ({ line, hits })).sort((a, b) => a.line - b.line);
}

function getAttr(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)?.[1];
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
