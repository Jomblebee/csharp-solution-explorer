// The text a run puts into the Test Results panel: the header and summary that delimit one run in a
// panel several runs share, the sink that decides how much host output survives `outputVerbosity`,
// and the message a project node gets when an MTP run produced nothing at all.
//
// vscode appears here only as a type (`import type`) — `run.appendOutput` is a method on the object
// handed in, not a namespace call — so the module carries no runtime dependency on the editor API and
// stays unit-testable.

import type * as vscode from "vscode";
import { summarizeHostFailure } from "./hostOutput.js";
import { createOutputFilter, toCrlf, type TestOutputLevel } from "./outputFilter.js";
import type { Selection } from "./testSelection.js";
import type { TrxOutcome, TrxTestResult } from "./trxParser.js";

/** Writes one line to the Test Results panel, which needs CRLF endings. */
export function writeLine(run: vscode.TestRun, text: string): void {
  run.appendOutput(toCrlf(text) + "\r\n");
}

/**
 * The sink for one line of host output: the Test Results panel gets the curated view, so failures
 * stay clickable there, and `level` decides how much of the rest survives. The full log is in the
 * "C# Tests" output channel either way.
 */
export function makeLogSink(run: vscode.TestRun, level: TestOutputLevel): (line: string) => void {
  const filter = createOutputFilter(level);
  return (line: string): void => {
    const kept = filter(line);
    if (kept !== undefined) {
      writeLine(run, kept);
    }
  };
}

export function headerLine(name: string, framework: string | undefined, selection: Selection): string {
  const scope = selection === "ALL" ? "all tests" : `${selection.size} selected test${selection.size === 1 ? "" : "s"}`;
  return `▶ ${name}${framework ? ` (${framework})` : ""} — ${scope}`;
}

/** `41 passed, 1 failed, 0 skipped in 3.2s`, counted from the parsed results rather than the log. */
export function summaryLine(results: TrxTestResult[], elapsedMs: number): string {
  const count = (outcome: TrxOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${count("Passed")} passed, ${count("Failed")} failed, ${count("NotExecuted")} skipped in ${seconds}s`;
}

/**
 * What to show on a project node when an MTP run produced no results at all. A crashed host is the
 * common case, so lead with the line that names the cause (unknown option, TypeLoadException, …) and
 * point at the full log rather than repeating it — the output channel always has all of it.
 */
export function mtpFailureMessage(ok: boolean, output: string): string {
  if (ok) {
    return "No tests were found in this project.";
  }
  const cause = summarizeHostFailure(output);
  return cause
    ? `${cause}\n\nThe test run failed. See the 'C# Tests' output channel for the full log.`
    : "The test run failed. See the 'C# Tests' output channel for the full log.";
}
