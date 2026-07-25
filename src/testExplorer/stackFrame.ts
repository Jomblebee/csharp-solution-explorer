// Pulls a source location out of a .NET stack trace. Needed because a classic TRX carries no source
// information at all (see trxParser.ts) — the only place a VSTest failure names a file and line is
// the stack trace text — so without this a failing test can only show a message, not jump to code.
//
// Pure and vscode-free so it stays unit-testable.

/**
 * Frame lines look like `   at Ns.C.M() in /repo/C.cs:line 42`. The `in … :line N` tail is what the
 * runtime writes; localized runtimes translate the `line` keyword (German `Zeile`), so the keyword is
 * matched loosely rather than spelled out. Windows paths (`C:\repo\C.cs`) are covered by taking the
 * *last* colon-number group on the line.
 */
const FRAME_PATTERN = /\bin\s+(?<file>.+?):\s*[A-Za-zÀ-ÿ]+\s+(?<line>\d+)\s*$/;

export interface StackLocation {
  file: string;
  /** 1-based, as the runtime reports it. */
  line: number;
}

/**
 * The first frame in `stackTrace` that names a file and line, or undefined when none does. First
 * rather than last: the topmost frame is where the assertion actually failed, while the bottom of the
 * trace is the test runner's own plumbing.
 */
export function parseStackFrame(stackTrace: string | undefined): StackLocation | undefined {
  if (!stackTrace) {
    return undefined;
  }
  for (const raw of stackTrace.split(/\r?\n/)) {
    const match = FRAME_PATTERN.exec(raw.trim());
    const file = match?.groups?.file?.trim();
    const line = Number(match?.groups?.line);
    if (file && Number.isFinite(line) && line > 0) {
      return { file, line };
    }
  }
  return undefined;
}
