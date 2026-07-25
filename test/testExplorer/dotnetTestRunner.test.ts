import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findNewestTrx } from "../../src/testExplorer/dotnetTestRunner.js";

// `runTests` spawns the `dotnet` CLI and is left to the manual F5 path; `findNewestTrx` is the part
// that decides which results file a run reports on, and it only needs a directory.
describe("findNewestTrx", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-trx-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Writes a file and stamps its mtime, rather than relying on write order and clock resolution. */
  function writeAt(name: string, epochSeconds: number): string {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, "<TestRun />");
    fs.utimesSync(file, epochSeconds, epochSeconds);
    return file;
  }

  it("returns undefined for a directory that was never created", async () => {
    assert.equal(await findNewestTrx(path.join(tempDir, "no-results")), undefined);
  });

  it("returns undefined when the run wrote no .trx", async () => {
    fs.writeFileSync(path.join(tempDir, "coverage.cobertura.xml"), "<coverage />");

    assert.equal(await findNewestTrx(tempDir), undefined);
  });

  it("returns the absolute path of the only .trx", async () => {
    const file = writeAt("results.trx", 1_700_000_000);

    assert.equal(await findNewestTrx(tempDir), file);
  });

  it("picks the newest of several .trx files", async () => {
    writeAt("older.trx", 1_700_000_000);
    const newest = writeAt("newer.trx", 1_700_000_500);
    writeAt("oldest.trx", 1_600_000_000);

    assert.equal(await findNewestTrx(tempDir), newest);
  });

  it("matches the extension case-insensitively", async () => {
    const file = writeAt("Results.TRX", 1_700_000_000);

    assert.equal(await findNewestTrx(tempDir), file);
  });

  it("ignores non-trx files sitting next to the results", async () => {
    const trx = writeAt("results.trx", 1_600_000_000);
    const other = path.join(tempDir, "coverage.cobertura.xml");
    fs.writeFileSync(other, "<coverage />");
    fs.utimesSync(other, 1_700_000_000, 1_700_000_000);

    assert.equal(await findNewestTrx(tempDir), trx);
  });
});
