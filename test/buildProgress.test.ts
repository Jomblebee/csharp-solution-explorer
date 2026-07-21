import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeProgress, createBuildProgressState, parseBuildLine } from "../src/solutionExplorer/buildProgress.js";

describe("parseBuildLine", () => {
  it("ignores blank lines", () => {
    assert.equal(parseBuildLine(""), undefined);
  });

  it("detects a project completion line", () => {
    assert.deepEqual(parseBuildLine("MyProject -> /repo/bin/Debug/net10.0/MyProject.dll"), {
      kind: "projectDone",
      name: "MyProject",
    });
  });

  it("detects a project completion line with a Windows-style path and .exe output", () => {
    assert.deepEqual(parseBuildLine("Tool -> C:\\repo\\bin\\Debug\\net10.0\\Tool.exe"), {
      kind: "projectDone",
      name: "Tool",
    });
  });

  it("detects a restore-complete marker", () => {
    assert.deepEqual(parseBuildLine("Restored /repo/MyProject.csproj (in 42 ms)."), { kind: "restoreDone" });
  });

  it("classifies unrelated output (including warnings) as other", () => {
    assert.deepEqual(parseBuildLine("MyProject.cs(12,5): warning CS0219: The variable 'x' is never used"), {
      kind: "other",
    });
  });

  it("does not false-positive on an arrow that isn't a build-output line", () => {
    assert.deepEqual(parseBuildLine("some log text -> not an assembly path"), { kind: "other" });
  });

  it("treats an absurdly long line as other rather than running the regex on it", () => {
    assert.deepEqual(parseBuildLine("x".repeat(5000)), { kind: "other" });
  });
});

describe("computeProgress", () => {
  it("moves 0 -> restoring -> compiling -> done for a single-project build, never decreasing", () => {
    const state = createBuildProgressState(1);
    const fractions: number[] = [];

    fractions.push(computeProgress(state, { kind: "restoreDone" }).fraction);
    fractions.push(computeProgress(state, { kind: "other" }).fraction);
    const final = computeProgress(state, { kind: "projectDone", name: "MyProject" });
    fractions.push(final.fraction);

    assert.deepEqual(fractions, [0.15, 0.7, 1]);
    assert.equal(final.message, "Build succeeded.");
    for (let i = 1; i < fractions.length; i++) {
      assert.ok(fractions[i] >= fractions[i - 1], "fraction must never decrease");
    }
  });

  it("advances per-project across a multi-project graph, ending at exactly 1", () => {
    const state = createBuildProgressState(3);
    const events: Array<Parameters<typeof computeProgress>[1]> = [
      { kind: "restoreDone" },
      { kind: "other" },
      { kind: "projectDone", name: "A" },
      { kind: "other" },
      { kind: "projectDone", name: "B" },
      { kind: "other" },
      { kind: "projectDone", name: "C" },
    ];

    let last = 0;
    let result: ReturnType<typeof computeProgress> = { fraction: 0, message: "" };
    for (const event of events) {
      result = computeProgress(state, event);
      assert.ok(result.fraction >= last, "fraction must never decrease");
      last = result.fraction;
    }

    assert.equal(result.fraction, 1);
    assert.equal(result.message, "Build succeeded.");
  });

  it("does not regress or over-count when a multi-TFM build prints two completion lines for one project", () => {
    const state = createBuildProgressState(1);
    const first = computeProgress(state, { kind: "projectDone", name: "MyProject" });
    assert.equal(first.fraction, 1);

    const second = computeProgress(state, { kind: "projectDone", name: "MyProject" });
    assert.equal(second.fraction, 1);
  });

  it("ignores warnings/errors interleaved in the output without affecting progress", () => {
    const state = createBuildProgressState(1);
    computeProgress(state, { kind: "restoreDone" });
    const beforeWarning = computeProgress(state, { kind: "other" }).fraction;
    const duringWarning = computeProgress(state, { kind: "other" }).fraction;
    assert.equal(duringWarning, beforeWarning);
  });

  it("clamps a zero or negative project count to at least one project", () => {
    const state = createBuildProgressState(0);
    const result = computeProgress(state, { kind: "projectDone", name: "Only" });
    assert.equal(result.fraction, 1);
  });
});
