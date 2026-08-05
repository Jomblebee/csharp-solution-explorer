import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_CACHE,
  mergeRun,
  predict,
  readCache,
  type DurationCacheData,
} from "../../../src/testExplorer/dashboard/durationCache.js";

describe("readCache", () => {
  it("falls back to an empty cache for anything it does not recognise", () => {
    for (const raw of [undefined, null, {}, "nonsense", { version: 2, run: 1, entries: {} }]) {
      assert.deepEqual(readCache(raw), EMPTY_CACHE);
    }
  });

  it("drops a corrupt entry but keeps the sound ones", () => {
    const cache = readCache({
      version: 1,
      run: 3,
      entries: { good: { ms: 12, run: 3 }, bad: { ms: "slow" }, negative: { ms: -1, run: 1 } },
    });
    assert.deepEqual(Object.keys(cache.entries), ["good"]);
    assert.equal(cache.run, 3);
  });

  it("treats a missing run counter as zero rather than rejecting the entry", () => {
    const cache = readCache({ version: 1, entries: { a: { ms: 5 } } });
    assert.deepEqual(cache.entries.a, { ms: 5, run: 0 });
  });
});

describe("predict", () => {
  it("returns a known duration and nothing for an unknown test", () => {
    const cache: DurationCacheData = { version: 1, run: 1, entries: { a: { ms: 42, run: 1 } } };
    assert.equal(predict(cache, "a"), 42);
    assert.equal(predict(cache, "b"), undefined);
  });
});

describe("mergeRun", () => {
  it("stores a first sighting as measured", () => {
    const merged = mergeRun(EMPTY_CACHE, new Map([["a", 120]]));
    assert.equal(merged.entries.a.ms, 120);
    assert.equal(merged.run, 1);
  });

  it("moves a known duration towards the new measurement without jumping to it", () => {
    const cache: DurationCacheData = { version: 1, run: 1, entries: { a: { ms: 200, run: 1 } } };
    const merged = mergeRun(cache, new Map([["a", 100]]));
    assert.ok(merged.entries.a.ms > 100 && merged.entries.a.ms < 200);
    // Weighted towards the newer measurement: 0.6 × 100 + 0.4 × 200.
    assert.equal(merged.entries.a.ms, 140);
  });

  it("ignores a nonsensical duration instead of poisoning the prediction", () => {
    const merged = mergeRun(EMPTY_CACHE, new Map([["a", Number.NaN], ["b", -5], ["c", 10]]));
    assert.deepEqual(Object.keys(merged.entries), ["c"]);
  });

  it("keeps the most recently seen entries when it has to prune", () => {
    let cache = mergeRun(EMPTY_CACHE, new Map([["old1", 1], ["old2", 2]]));
    cache = mergeRun(cache, new Map([["new1", 3], ["new2", 4], ["new3", 5]]), 3);
    assert.deepEqual(Object.keys(cache.entries).sort(), ["new1", "new2", "new3"]);
    assert.equal(cache.run, 2);
  });

  it("leaves the source cache untouched", () => {
    const cache: DurationCacheData = { version: 1, run: 1, entries: { a: { ms: 200, run: 1 } } };
    mergeRun(cache, new Map([["a", 100]]));
    assert.equal(cache.entries.a.ms, 200);
    assert.equal(cache.run, 1);
  });
});
