// Pure progress bookkeeping for a server-side test run. Roslyn reports *cumulative* counts with every
// partial result, while VS Code's progress API takes a *delta* per report — converting between the
// two (and the summary line that goes with it) is the only logic in the run worth testing, so it
// lives here, free of the vscode module.

export interface TestProgress {
  totalTests: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
}

/** Tests the server has finished so far, whatever their outcome. */
export function completedCount(progress: TestProgress): number {
  return progress.testsPassed + progress.testsFailed + progress.testsSkipped;
}

/**
 * The percentage to advance the progress bar for a report, given how many tests were already
 * counted. Guards the two shapes a server can send at the very start of a run: a zero total (nothing
 * discovered yet — the bar must not divide by it) and a count that went backwards (a re-discovery),
 * which would otherwise report a negative increment.
 */
export function progressIncrement(progress: TestProgress, alreadyCounted: number): number {
  if (progress.totalTests <= 0) {
    return 0;
  }
  const delta = completedCount(progress) - alreadyCounted;
  return delta <= 0 ? 0 : (delta / progress.totalTests) * 100;
}

/** The one-line tally shown next to the stage in the progress notification. */
export function formatSummary(progress: TestProgress): string {
  return `${progress.testsPassed} passed, ${progress.testsFailed} failed, ${progress.testsSkipped} skipped of ${progress.totalTests}`;
}
