import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { debounce, debounceCollect } from "../../src/shared/debounce.js";

const WINDOW_MS = 10;

/** Resolves once the debounce window has certainly elapsed. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 4));
}

describe("debounce", () => {
  it("collapses a burst into a single trailing call", async () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), WINDOW_MS);

    fn(1);
    fn(2);
    fn(3);
    assert.deepEqual(calls, []); // trailing edge: nothing has run yet

    await settle();
    assert.deepEqual(calls, [3]);
  });

  it("runs again for a call after the window has passed", async () => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), WINDOW_MS);

    fn(1);
    await settle();
    fn(2);
    await settle();

    assert.deepEqual(calls, [1, 2]);
  });
});

describe("debounceCollect", () => {
  it("hands the callback every item of the burst, not just the last", async () => {
    const batches: string[][] = [];
    const fn = debounceCollect((items: string[]) => batches.push(items), WINDOW_MS);

    fn("/repo/A/TaskTests.cs");
    fn("/repo/B/ProjectTests.cs");
    await settle();

    assert.deepEqual(batches, [["/repo/A/TaskTests.cs", "/repo/B/ProjectTests.cs"]]);
  });

  it("de-duplicates an item that fires several times in one burst", async () => {
    const batches: string[][] = [];
    const fn = debounceCollect((items: string[]) => batches.push(items), WINDOW_MS);

    fn("/repo/A/TaskTests.cs");
    fn("/repo/A/TaskTests.cs");
    fn("/repo/A/TaskTests.cs");
    await settle();

    assert.deepEqual(batches, [["/repo/A/TaskTests.cs"]]);
  });

  it("starts a fresh batch after flushing", async () => {
    const batches: string[][] = [];
    const fn = debounceCollect((items: string[]) => batches.push(items), WINDOW_MS);

    fn("a");
    await settle();
    fn("b");
    await settle();

    assert.deepEqual(batches, [["a"], ["b"]]);
  });

  it("does not call back when nothing happened", async () => {
    const batches: string[][] = [];
    debounceCollect((items: string[]) => batches.push(items), WINDOW_MS);

    await settle();
    assert.deepEqual(batches, []);
  });
});
