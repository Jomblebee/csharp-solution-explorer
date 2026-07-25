// Decides what a test run's raw stdout contributes to the VS Code test-run terminal. The full log
// always goes to the "C# Tests" output channel unfiltered; this module only curates the terminal,
// which used to show the entire `dotnet test` transcript — restore, MSBuild, VSTest banner, one line
// per passing test — and drowned the two things a run is actually about: failures and the summary.
//
// Pure and vscode-free so it stays unit-testable.

import { parseBuildLine } from "../solutionExplorer/buildProgress.js";
import { FAILURE_PATTERN } from "./hostOutput.js";

/** How much of the host log reaches the test-run terminal. The values the setting exposes. */
export type TestOutputLevel = "summary" | "normal" | "full";

/**
 * Levels the filter understands, including the one the setting does not offer: `critical` keeps only
 * build diagnostics and failures. It is what the Test Results panel gets once the full log lives in
 * a terminal — everything else there is chatter the user asked to see somewhere else, and a host's
 * own session lines ("Starting test session") are localized, so dropping by allow-list is the only
 * approach that works in every language.
 */
export type FilterLevel = TestOutputLevel | "critical";

/**
 * Environment that keeps a spawned test process from decorating its output. Set as environment
 * rather than as CLI flags on purpose: a flag the runner does not know aborts the whole run (as
 * `--coverage` does on hosts without the coverage extension), an unknown variable never does.
 */
export const QUIET_ENV: NodeJS.ProcessEnv = {
  // The terminal logger is what emits the cursor-move sequences the run terminal cannot replay.
  MSBUILDTERMINALLOGGER: "off",
  DOTNET_NOLOGO: "1",
  NO_COLOR: "1",
};

/**
 * CSI and OSC escape sequences. MSBuild's terminal logger emits cursor moves and colour codes that
 * the run terminal renders as garbage, since it replays text rather than driving a real terminal.
 */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/** Compiler/MSBuild diagnostics — kept at every level, they are the reason a run failed to build. */
const DIAGNOSTIC_PATTERN = /\b(?:error|warning)\s+[A-Z]{2,}\d+\b|\bMSB\d{4}\b/;

/** Restore/build/VSTest chrome that says nothing about the tests themselves. */
const CHROME_PATTERNS = [
  /^\s*Determining projects to restore/i,
  /^\s*Build (?:succeeded|started)/i,
  /^\s*MSBuild version /i,
  /^\s*Microsoft \(R\) /i,
  /^\s*Copyright \(C\) Microsoft/i,
  /^\s*Test run for /i,
  /^\s*VSTest version /i,
  /^\s*Starting test execution/i,
  /^\s*A total of \d+ test files matched/i,
  /^\s*\d+ Warning\(s\)$/i,
  /^\s*\d+ Error\(s\)$/i,
  /^\s*Time Elapsed \d/i,
];

/** Per-test chatter that `summary` drops but `normal` keeps. */
const UNINTERESTING_RESULT_PATTERN = /^\s*(?:Passed|Skipped|NotExecuted)[\s!]/;

/** A reported test failure, the one per-test line worth keeping at every level. */
const FAILED_RESULT_PATTERN = /^\s*Failed[\s!]/;

/**
 * A line filter for the given level: returns the text to write to the run terminal, or `undefined`
 * to drop the line. Consecutive blank lines collapse into one, so the filter is stateful — create
 * one per run.
 */
export function createOutputFilter(level: FilterLevel): (line: string) => string | undefined {
  let lastWasBlank = false;

  return (raw: string): string | undefined => {
    if (level === "full") {
      return raw;
    }
    const line = raw.replace(ANSI_PATTERN, "");
    if (line.trim() === "") {
      if (level === "critical" || lastWasBlank) {
        return undefined;
      }
      lastWasBlank = true;
      return "";
    }
    lastWasBlank = false;

    // Never hide why a build or a host died, whatever the level.
    if (DIAGNOSTIC_PATTERN.test(line) || FAILURE_PATTERN.test(line)) {
      return line;
    }
    // An allow-list, so a host's localized session chatter cannot slip through by not matching a
    // drop rule. Only used when the full log is somewhere the user can already read it.
    if (level === "critical") {
      return FAILED_RESULT_PATTERN.test(line) ? line : undefined;
    }
    if (CHROME_PATTERNS.some((pattern) => pattern.test(line))) {
      return undefined;
    }
    // `X -> /path/X.dll` and `Restored …` — the build's own progress, already shown as a notification.
    const event = parseBuildLine(line);
    if (event && event.kind !== "other") {
      return undefined;
    }
    if (level === "summary" && UNINTERESTING_RESULT_PATTERN.test(line)) {
      return undefined;
    }
    return line;
  };
}

/** VS Code's test-run terminal needs CRLF line endings; normalizes any bare `\n` in host output. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * Buffers arbitrary stdout chunks into whole lines (CR-trimmed), for callers that receive raw
 * `data` events rather than lines. Call `flush` when the stream ends so a trailing partial line is
 * not lost.
 */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = "";
  return {
    push(chunk: string): void {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line.replace(/\r$/, ""));
      }
    },
    flush(): void {
      if (rest.length > 0) {
        onLine(rest.replace(/\r$/, ""));
        rest = "";
      }
    },
  };
}
