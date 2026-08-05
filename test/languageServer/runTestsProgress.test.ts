import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  completedCount,
  formatSummary,
  progressIncrement,
  type TestProgress,
} from "../../src/languageServer/runTestsProgress.js";

function progress(part: Partial<TestProgress>): TestProgress {
  return { totalTests: 0, testsPassed: 0, testsFailed: 0, testsSkipped: 0, ...part };
}

describe("completedCount", () => {
  it("counts every finished test, whatever its outcome", () => {
    assert.equal(completedCount(progress({ testsPassed: 3, testsFailed: 2, testsSkipped: 1 })), 6);
  });
});

describe("progressIncrement", () => {
  it("reports the share of the total gained since the last report", () => {
    assert.equal(progressIncrement(progress({ totalTests: 4, testsPassed: 3 }), 1), 50);
  });

  it("stays at zero before the server has discovered anything", () => {
    assert.equal(progressIncrement(progress({ totalTests: 0, testsPassed: 2 }), 0), 0);
  });

  it("never goes backwards when a count is re-reported lower", () => {
    assert.equal(progressIncrement(progress({ totalTests: 10, testsPassed: 1 }), 4), 0);
  });
});

describe("formatSummary", () => {
  it("tallies the outcomes against the total", () => {
    assert.equal(
      formatSummary(progress({ totalTests: 6, testsPassed: 4, testsFailed: 1, testsSkipped: 1 })),
      "4 passed, 1 failed, 1 skipped of 6",
    );
  });
});
