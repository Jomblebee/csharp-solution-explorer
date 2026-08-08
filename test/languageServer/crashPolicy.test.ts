import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrashTracker, DEFAULT_CRASH_POLICY } from "../../src/languageServer/crashPolicy.js";

describe("CrashTracker", () => {
  it("restarts with a growing backoff", () => {
    const tracker = new CrashTracker({ maxRestarts: 3, windowMs: 1000, delaysMs: [1, 2, 5] });
    assert.deepEqual(tracker.record(0), { kind: "restart", attempt: 1, delayMs: 1 });
    assert.deepEqual(tracker.record(10), { kind: "restart", attempt: 2, delayMs: 2 });
    assert.deepEqual(tracker.record(20), { kind: "restart", attempt: 3, delayMs: 5 });
  });

  it("gives up once the allowance inside the window is used up", () => {
    const tracker = new CrashTracker({ maxRestarts: 2, windowMs: 1000, delaysMs: [1] });
    tracker.record(0);
    tracker.record(10);
    assert.deepEqual(tracker.record(20), { kind: "giveUp", crashes: 3, windowMs: 1000 });
  });

  it("reuses the last delay when there are more attempts than delays", () => {
    const tracker = new CrashTracker({ maxRestarts: 4, windowMs: 1000, delaysMs: [1, 7] });
    tracker.record(0);
    tracker.record(1);
    assert.deepEqual(tracker.record(2), { kind: "restart", attempt: 3, delayMs: 7 });
    assert.deepEqual(tracker.record(3), { kind: "restart", attempt: 4, delayMs: 7 });
  });

  it("forgets crashes that fell out of the window", () => {
    const tracker = new CrashTracker({ maxRestarts: 1, windowMs: 1000, delaysMs: [1] });
    assert.equal(tracker.record(0).kind, "restart");
    // Still inside the window → the second crash exhausts the allowance.
    assert.equal(tracker.record(500).kind, "giveUp");
    // Both are older than the window by now, so the server gets its full allowance again.
    assert.equal(tracker.record(2000).kind, "restart");
  });

  it("forgets the history on reset", () => {
    const tracker = new CrashTracker({ maxRestarts: 1, windowMs: 1000, delaysMs: [1] });
    tracker.record(0);
    tracker.reset();
    assert.deepEqual(tracker.record(10), { kind: "restart", attempt: 1, delayMs: 1 });
  });

  it("ships a default policy that recovers a few times but not forever", () => {
    const tracker = new CrashTracker();
    for (let i = 0; i < DEFAULT_CRASH_POLICY.maxRestarts; i++) {
      assert.equal(tracker.record(i).kind, "restart");
    }
    assert.equal(tracker.record(DEFAULT_CRASH_POLICY.maxRestarts).kind, "giveUp");
  });
});
