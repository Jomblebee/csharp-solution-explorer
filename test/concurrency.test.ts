import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/nuget/concurrency.js";

/** Resolves after the current microtask queue drains a few times, so pending work can settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mapLimit", () => {
  it("never runs more than `limit` tasks at once", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (item) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return item;
    });
    assert.equal(peak, 3);
  });

  it("returns results in input order even when tasks finish out of order", async () => {
    const delays = [30, 0, 20, 10];
    const results = await mapLimit(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    assert.deepEqual(results, [0, 1, 2, 3]);
  });

  it("passes the input index to the mapper", async () => {
    assert.deepEqual(await mapLimit(["a", "b", "c"], 2, async (item, index) => `${index}:${item}`), [
      "0:a",
      "1:b",
      "2:c",
    ]);
  });

  it("propagates the first rejection", async () => {
    await assert.rejects(
      () => mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error("boom");
        }
        return n;
      }),
      /boom/,
    );
  });

  it("handles an empty input and a limit larger than the input", async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
    assert.deepEqual(await mapLimit([1, 2], 99, async (n) => n * 2), [2, 4]);
  });

  it("treats a zero or negative limit as sequential rather than stalling", async () => {
    let peak = 0;
    let running = 0;
    const results = await mapLimit([1, 2, 3], 0, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return n;
    });
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(peak, 1);
  });
});
