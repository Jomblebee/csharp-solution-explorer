// Keeps the test host's console output around so a failed run can say what actually went wrong.
// The MTP runner streams stdout/stderr straight into the run terminal, which is fine while a run is
// live but leaves nothing to put in the `TestMessage` when the host dies before reporting any test —
// the user used to get a bare "The test run failed." while the real cause (an unknown `--coverage`
// option, a TypeLoadException from a mismatched extension) scrolled past in the terminal.
//
// Pure and vscode-free so it stays unit-testable.

/** Upper bound on retained host output: enough for a full exception dump, small enough to hold. */
export const MAX_HOST_OUTPUT_CHARS = 64 * 1024;

export interface TailBuffer {
  append(text: string): void;
  /** The retained text (at most `maxChars` characters, the most recent ones). */
  text(): string;
}

/** A bounded accumulator that keeps only the last `maxChars` characters appended to it. */
export function createTailBuffer(maxChars = MAX_HOST_OUTPUT_CHARS): TailBuffer {
  let buffer = "";
  return {
    append(text: string): void {
      buffer += text;
      if (buffer.length > maxChars) {
        buffer = buffer.slice(buffer.length - maxChars);
      }
    },
    text: () => buffer,
  };
}

/**
 * Lines that identify why a test host failed. Covers .NET crashes, the platform's own option parser
 * (localized — hence matching the quoted option rather than the sentence around it) and build errors.
 */
export const FAILURE_PATTERN =
  /(Unhandled exception|System\.[A-Za-z0-9_.]*Exception|Unknown option|Unbekannte Option|Fatal error|error [A-Z]{2}\d+)/i;

/**
 * A short excerpt of a failed host's output for a `TestMessage`: the first line that looks like the
 * cause plus the lines under it (a stack trace's first frames), or the tail when nothing matches.
 * Deliberately short — the full log is already in the "C# Tests" output channel.
 */
export function summarizeHostFailure(output: string, maxLines = 12): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return "";
  }
  const start = lines.findIndex((line) => FAILURE_PATTERN.test(line));
  const excerpt = start === -1 ? lines.slice(-maxLines) : lines.slice(start, start + maxLines);
  return excerpt.join("\n");
}
