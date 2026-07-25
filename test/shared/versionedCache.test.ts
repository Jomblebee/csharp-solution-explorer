import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearVersionCache, pruneVersionCache, versionsToPrune } from "../../src/shared/versionedCache.js";

describe("versionsToPrune", () => {
  it("keeps the version in use and returns the rest", () => {
    assert.deepEqual(versionsToPrune(["4.13.0", "5.0.0", "5.1.0"], "5.1.0"), ["4.13.0", "5.0.0"]);
  });

  it("returns everything when the kept version is not among them (override path in use)", () => {
    assert.deepEqual(versionsToPrune(["4.13.0", "5.0.0"], "9.9.9"), ["4.13.0", "5.0.0"]);
  });

  it("returns nothing for an empty cache", () => {
    assert.deepEqual(versionsToPrune([], "5.1.0"), []);
  });
});

describe("pruneVersionCache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-version-cache-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A `<root>/<version>/<rid>/file` layout, the shape the downloaders lay down. */
  function seedVersion(version: string): void {
    const ridDir = path.join(tempDir, version, "linux-x64");
    fs.mkdirSync(ridDir, { recursive: true });
    fs.writeFileSync(path.join(ridDir, "netcoredbg"), "binary");
  }

  it("removes every version except the one in use, contents and all", async () => {
    seedVersion("4.13.0");
    seedVersion("5.0.0");
    seedVersion("5.1.0");

    const removed = await pruneVersionCache(tempDir, "5.1.0");

    assert.deepEqual(removed.sort(), ["4.13.0", "5.0.0"]);
    assert.deepEqual(fs.readdirSync(tempDir), ["5.1.0"]);
    assert.equal(fs.existsSync(path.join(tempDir, "5.1.0", "linux-x64", "netcoredbg")), true);
  });

  it("removes nothing when only the kept version is cached", async () => {
    seedVersion("5.1.0");

    assert.deepEqual(await pruneVersionCache(tempDir, "5.1.0"), []);
    assert.deepEqual(fs.readdirSync(tempDir), ["5.1.0"]);
  });

  it("leaves loose files next to the version directories alone", async () => {
    seedVersion("5.1.0");
    seedVersion("5.0.0");
    fs.writeFileSync(path.join(tempDir, "download.tmp"), "x");

    const removed = await pruneVersionCache(tempDir, "5.1.0");

    assert.deepEqual(removed, ["5.0.0"]);
    assert.equal(fs.existsSync(path.join(tempDir, "download.tmp")), true);
  });

  it("reports nothing removed for a root that does not exist yet", async () => {
    assert.deepEqual(await pruneVersionCache(path.join(tempDir, "never-downloaded"), "5.1.0"), []);
  });
});

describe("clearVersionCache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-version-cache-clear-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes the whole cache root", async () => {
    const root = path.join(tempDir, "netcoredbg");
    fs.mkdirSync(path.join(root, "5.1.0", "linux-x64"), { recursive: true });

    await clearVersionCache(root);

    assert.equal(fs.existsSync(root), false);
  });

  it("does not throw when the root is already gone", async () => {
    await clearVersionCache(path.join(tempDir, "never-downloaded"));
  });
});
