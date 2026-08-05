import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateEta,
  formatDuration,
  formatEta,
  median,
  type EtaEstimate,
  type EtaInputs,
} from "../../../src/testExplorer/dashboard/testRunEta.js";

function inputs(part: Partial<EtaInputs>): EtaInputs {
  return {
    startedAt: 0,
    firstCompletionAt: undefined,
    now: 0,
    completed: 0,
    total: undefined,
    observedDurations: [],
    predictedRemaining: [],
    activeProjects: 1,
    previous: undefined,
    ...part,
  };
}

/** The smoothing is an EMA against the previous estimate, so a first estimate needs no previous. */
function first(part: Partial<EtaInputs>): EtaEstimate {
  return estimateEta(inputs(part));
}

describe("median", () => {
  it("has nothing to report for an empty sample", () => {
    assert.equal(median([]), undefined);
  });

  it("takes the middle value of an odd-length sample", () => {
    assert.equal(median([5, 1, 3]), 3);
  });

  it("averages the two middle values of an even-length sample", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it("is not moved by a single slow outlier", () => {
    const values = [...Array<number>(500).fill(5), 30_000];
    assert.equal(median(values), 5);
  });
});

describe("estimateEta — no honest basis", () => {
  it("reports none while the total is unknown", () => {
    const estimate = first({ completed: 4, total: undefined });
    assert.equal(estimate.basis, "none");
    assert.equal(estimate.remainingMs, undefined);
    assert.equal(estimate.fraction, undefined);
  });

  it("reports none for a total of zero rather than dividing by it", () => {
    assert.equal(first({ total: 0, completed: 0 }).basis, "none");
  });

  it("reports none before the first test finishes without a cache to go on", () => {
    const estimate = first({ total: 100, completed: 0, predictedRemaining: Array<undefined>(100).fill(undefined) });
    assert.equal(estimate.basis, "none");
    assert.equal(estimate.fraction, 0);
  });
});

describe("estimateEta — rate", () => {
  it("extrapolates from the pace since the first completion", () => {
    const estimate = first({
      total: 100,
      completed: 10,
      firstCompletionAt: 0,
      now: 1000,
      predictedRemaining: Array<undefined>(90).fill(undefined),
    });
    assert.equal(estimate.basis, "rate");
    assert.equal(estimate.remainingMs, 9000);
  });

  it("ignores the build time before the first result", () => {
    // Eight seconds of building, then ten tests in one second. The build must not be extrapolated.
    const estimate = first({
      startedAt: 0,
      firstCompletionAt: 8000,
      now: 9000,
      total: 100,
      completed: 10,
      predictedRemaining: Array<undefined>(90).fill(undefined),
    });
    assert.equal(estimate.remainingMs, 9000);
  });

  it("is zero once every test has finished", () => {
    const estimate = first({ total: 20, completed: 20, firstCompletionAt: 0, now: 5000 });
    assert.equal(estimate.remainingMs, 0);
    assert.equal(estimate.fraction, 1);
  });
});

describe("estimateEta — durations", () => {
  it("produces a number before the first test finishes when the cache covers the run", () => {
    const estimate = first({ total: 4, completed: 0, predictedRemaining: [100, 200, 300, 400] });
    assert.equal(estimate.basis, "durations");
    assert.equal(estimate.remainingMs, 1000);
  });

  it("divides by the projects actually running, since they run concurrently", () => {
    const serial = first({ total: 4, completed: 0, predictedRemaining: [100, 200, 300, 400], activeProjects: 1 });
    const parallel = first({ total: 4, completed: 0, predictedRemaining: [100, 200, 300, 400], activeProjects: 4 });
    assert.equal(parallel.remainingMs, (serial.remainingMs ?? 0) / 4);
  });

  it("fills unknown tests with the median of what this run has shown", () => {
    const estimate = first({
      total: 4,
      completed: 2,
      firstCompletionAt: 0,
      now: 1000,
      observedDurations: [100, 100],
      predictedRemaining: [400, undefined],
    });
    assert.equal(estimate.basis, "durations");
    assert.equal(estimate.remainingMs, 500);
  });

  it("falls back to the rate when the cache knows too few of the remaining tests", () => {
    const estimate = first({
      total: 10,
      completed: 5,
      firstCompletionAt: 0,
      now: 1000,
      predictedRemaining: [100, 100, undefined, undefined, undefined],
    });
    assert.equal(estimate.basis, "rate");
  });
});

describe("estimateEta — fraction and smoothing", () => {
  it("clamps the fraction when a growing total lands behind the completed count", () => {
    const estimate = first({ total: 4, completed: 6, firstCompletionAt: 0, now: 100 });
    assert.equal(estimate.fraction, 1);
  });

  it("lowers the fraction as discovery grows the total", () => {
    const before = first({ total: 10, completed: 5, firstCompletionAt: 0, now: 100 });
    const after = first({ total: 20, completed: 5, firstCompletionAt: 0, now: 100 });
    assert.equal(before.fraction, 0.5);
    assert.equal(after.fraction, 0.25);
  });

  it("damps a spike towards the previous estimate of the same basis", () => {
    const previous: EtaEstimate = { remainingMs: 1000, basis: "durations", fraction: 0.5 };
    const estimate = estimateEta(
      inputs({ total: 4, completed: 0, predictedRemaining: [5000, 5000, 5000, 5000], previous }),
    );
    // Raw would be 20000; the EMA keeps it far below that.
    assert.equal(estimate.remainingMs, 6700);
  });

  it("starts fresh when the basis changes, rather than blending two different measurements", () => {
    const previous: EtaEstimate = { remainingMs: 60_000, basis: "rate", fraction: 0.1 };
    const estimate = estimateEta(inputs({ total: 2, completed: 0, predictedRemaining: [100, 100], previous }));
    assert.equal(estimate.basis, "durations");
    assert.equal(estimate.remainingMs, 200);
  });

  it("never reports a negative remainder", () => {
    const previous: EtaEstimate = { remainingMs: 0, basis: "rate", fraction: 1 };
    const estimate = estimateEta(inputs({ total: 10, completed: 10, firstCompletionAt: 0, now: 1, previous }));
    assert.ok((estimate.remainingMs ?? 0) >= 0);
  });
});

describe("formatDuration", () => {
  it("formats the range a run actually spans", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(950), "0.9s");
    assert.equal(formatDuration(1200), "1.2s");
    assert.equal(formatDuration(59_999), "59s");
    assert.equal(formatDuration(65_000), "1m 05s");
    assert.equal(formatDuration(3_725_000), "1h 02m");
  });
});

describe("formatEta", () => {
  it("admits when there is nothing to go on", () => {
    assert.equal(formatEta({ remainingMs: undefined, basis: "none", fraction: undefined }), "estimating…");
  });

  it("hedges a rate-based guess and commits to a cache-based one", () => {
    assert.equal(formatEta({ remainingMs: 65_000, basis: "rate", fraction: 0.2 }), "roughly 1m 05s remaining");
    assert.equal(formatEta({ remainingMs: 65_000, basis: "durations", fraction: 0.2 }), "about 1m 05s remaining");
  });

  it("stops counting down in the last second", () => {
    assert.equal(formatEta({ remainingMs: 400, basis: "rate", fraction: 0.99 }), "almost done");
  });
});
