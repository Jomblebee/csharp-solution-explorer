import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DashboardOutcome, TestRow } from "../../../src/testExplorer/dashboard/dashboardProtocol.js";
import { TestRunTracker } from "../../../src/testExplorer/dashboard/testRunTracker.js";

interface Harness {
  tracker: TestRunTracker;
  changes(): number;
}

function harness(predict: (id: string) => number | undefined = () => undefined): Harness {
  const now = 1000;
  let changes = 0;
  const tracker = new TestRunTracker({
    header: { runId: 1, startedAt: now, debug: false, coverage: false, title: "Running 2 projects" },
    now: () => now,
    predict,
    onChange: () => {
      changes++;
    },
  });
  return { tracker, changes: () => changes };
}

function row(part: Partial<TestRow> & { id: string; project: string }): TestRow {
  return {
    name: part.id,
    className: "Tests",
    outcome: "passed" as DashboardOutcome,
    hasSource: true,
    ...part,
  };
}

function startProject(tracker: TestRunTracker, id: string, liveResults = true): void {
  tracker.projectStarted({ id, name: id, liveResults });
}

describe("TestRunTracker — counts", () => {
  it("aggregates interleaved results from concurrent projects onto the right project", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    startProject(tracker, "b");
    tracker.testFinished(row({ id: "a1", project: "a", outcome: "passed" }));
    tracker.testFinished(row({ id: "b1", project: "b", outcome: "failed" }));
    tracker.testFinished(row({ id: "a2", project: "a", outcome: "skipped" }));

    const update = tracker.snapshot();
    assert.equal(update.completed, 3);
    assert.equal(update.passed, 1);
    assert.equal(update.failed, 1);
    assert.equal(update.skipped, 1);
    const [a, b] = update.projects;
    assert.deepEqual([a.completed, a.passed, a.skipped], [2, 1, 1]);
    assert.deepEqual([b.completed, b.failed], [1, 1]);
  });

  it("counts a test reported twice only once", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a" }));
    tracker.testFinished(row({ id: "a1", project: "a" }));
    assert.equal(tracker.snapshot().completed, 1);
  });

  it("marks the run failed when a test errored rather than failed", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a", outcome: "errored" }));
    tracker.end(false);
    assert.equal(tracker.snapshot().state, "failed");
  });

  it("reports a cancelled run as cancelled, whatever the results were", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a" }));
    tracker.end(true);
    assert.equal(tracker.snapshot().state, "cancelled");
  });
});

describe("TestRunTracker — totals", () => {
  it("treats the total as a floor while a project cannot say how many tests it has", () => {
    const { tracker } = harness();
    startProject(tracker, "mtp");
    startProject(tracker, "vstest", false);
    tracker.projectTotal("mtp", 2, ["m1", "m2"]);
    tracker.testFinished(row({ id: "v1", project: "vstest" }));

    const update = tracker.snapshot();
    assert.equal(update.totalIsLowerBound, true);
    assert.equal(update.total, 3);
    // A floor cannot be extrapolated from, so there is deliberately no estimate yet.
    assert.equal(update.eta.basis, "none");
  });

  it("becomes exact once the uncountable project has finished", () => {
    const { tracker } = harness();
    startProject(tracker, "vstest", false);
    tracker.testFinished(row({ id: "v1", project: "vstest" }));
    tracker.testFinished(row({ id: "v2", project: "vstest" }));
    tracker.projectFinished("vstest", true);

    const update = tracker.snapshot();
    assert.equal(update.totalIsLowerBound, false);
    assert.equal(update.total, 2);
  });

  it("counts a filtered VSTest selection exactly, because the ids are known up front", () => {
    const { tracker } = harness();
    startProject(tracker, "vstest", false);
    tracker.projectTotal("vstest", 2, ["v1", "v2"]);
    const update = tracker.snapshot();
    assert.equal(update.totalIsLowerBound, false);
    assert.equal(update.total, 2);
  });

  it("estimates from the cache before any test has finished", () => {
    const { tracker } = harness(() => 250);
    startProject(tracker, "mtp");
    tracker.projectTotal("mtp", 4, ["m1", "m2", "m3", "m4"]);
    tracker.projectPhase("mtp", "running");
    const update = tracker.snapshot();
    assert.equal(update.eta.basis, "durations");
    assert.equal(update.eta.remainingMs, 1000);
  });
});

describe("TestRunTracker — phases", () => {
  it("leaves the building phase on the first result", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.projectPhase("a", "building");
    tracker.testStarted({ id: "a1", name: "a1", project: "a", startedAt: 1000 });
    assert.equal(tracker.snapshot().projects[0].phase, "running");
  });

  it("leaves the building phase on the first host output line", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.projectPhase("a", "building");
    tracker.output("a", "  Determining projects to restore...  ");
    const project = tracker.snapshot().projects[0];
    assert.equal(project.phase, "running");
    assert.equal(project.lastLine, "Determining projects to restore...");
  });

  it("ignores a blank output line rather than blanking the heartbeat", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.output("a", "real line");
    tracker.output("a", "   ");
    assert.equal(tracker.snapshot().projects[0].lastLine, "real line");
  });
});

describe("TestRunTracker — drain and snapshot", () => {
  it("returns only what is new since the last drain", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a" }));
    assert.deepEqual(
      tracker.drain().finished.map((r) => r.id),
      ["a1"],
    );
    assert.deepEqual(tracker.drain().finished, []);
    tracker.testFinished(row({ id: "a2", project: "a" }));
    assert.deepEqual(
      tracker.drain().finished.map((r) => r.id),
      ["a2"],
    );
  });

  it("hands a freshly opened panel the capped history, flagged as a full replacement", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    for (let i = 0; i < 400; i++) {
      tracker.testFinished(row({ id: `a${i}`, project: "a" }));
    }
    const update = tracker.snapshot();
    assert.equal(update.full, true);
    assert.equal(update.finished.length, 200);
    assert.equal(update.completed, 400);
  });
});

describe("TestRunTracker — caps", () => {
  it("caps a flush at 200 rows and reports how many it dropped", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    for (let i = 0; i < 500; i++) {
      tracker.testFinished(row({ id: `a${i}`, project: "a" }));
    }
    const update = tracker.drain();
    assert.equal(update.finished.length, 200);
    assert.equal(update.finishedDropped, 300);
    assert.equal(update.completed, 500);
  });

  it("caps the failure list and says so", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    for (let i = 0; i < 600; i++) {
      tracker.testFinished(row({ id: `a${i}`, project: "a", outcome: "failed" }));
    }
    const update = tracker.snapshot();
    assert.equal(update.failures.length, 500);
    assert.equal(update.failuresTruncated, true);
  });

  it("caps the running list", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    for (let i = 0; i < 80; i++) {
      tracker.testStarted({ id: `a${i}`, name: `a${i}`, project: "a", startedAt: 1000 });
    }
    assert.equal(tracker.snapshot().running.length, 50);
  });

  it("truncates a long failure message instead of shipping the whole stack", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a", outcome: "failed", message: "x".repeat(1000) }));
    const message = tracker.snapshot().failures[0].message ?? "";
    assert.equal(message.length, 401);
    assert.ok(message.endsWith("…"));
  });
});

describe("TestRunTracker — slowest tests", () => {
  it("keeps the ten slowest, descending", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    for (let i = 1; i <= 15; i++) {
      tracker.testFinished(row({ id: `a${i}`, project: "a", durationMs: i * 10 }));
    }
    const slowest = tracker.snapshot().slowest;
    assert.equal(slowest.length, 10);
    assert.equal(slowest[0].durationMs, 150);
    assert.equal(slowest[9].durationMs, 60);
  });

  it("reports a delta only for tests the cache has seen before", () => {
    const { tracker } = harness((id) => (id === "a1" ? 100 : undefined));
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a", durationMs: 180 }));
    tracker.testFinished(row({ id: "a2", project: "a", durationMs: 170 }));
    const [first, second] = tracker.snapshot().slowest;
    assert.equal(first.deltaMs, 80);
    assert.equal(second.deltaMs, undefined);
  });
});

describe("TestRunTracker — lifecycle", () => {
  it("notifies on every mutation and once more when the run ends", () => {
    const h = harness();
    startProject(h.tracker, "a");
    const afterStart = h.changes();
    h.tracker.testFinished(row({ id: "a1", project: "a" }));
    h.tracker.end(false);
    assert.equal(h.changes(), afterStart + 2);
  });

  it("goes quiet after the run has ended", () => {
    const h = harness();
    startProject(h.tracker, "a");
    h.tracker.end(false);
    const afterEnd = h.changes();
    h.tracker.testFinished(row({ id: "a1", project: "a" }));
    h.tracker.output("a", "late line");
    assert.equal(h.changes(), afterEnd);
    assert.equal(h.tracker.snapshot().completed, 0);
  });

  it("stops driving the panel once detached, but keeps aggregating for the cache", () => {
    const h = harness();
    startProject(h.tracker, "a");
    h.tracker.detach();
    const afterDetach = h.changes();
    h.tracker.testFinished(row({ id: "a1", project: "a", durationMs: 5 }));
    assert.equal(h.changes(), afterDetach);
    assert.equal(h.tracker.durations.get("a1"), 5);
  });

  it("collects durations only for tests that reported one", () => {
    const { tracker } = harness();
    startProject(tracker, "a");
    tracker.testFinished(row({ id: "a1", project: "a", durationMs: 12 }));
    tracker.testFinished(row({ id: "a2", project: "a" }));
    assert.deepEqual([...tracker.durations], [["a1", 12]]);
  });
});
