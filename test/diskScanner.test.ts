import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listAllFilesRecursive, listDirectChildren, shouldExcludeDir } from "../src/solutionExplorer/diskScanner.js";

describe("shouldExcludeDir", () => {
  it("excludes well-known build/dependency directory names", () => {
    assert.equal(shouldExcludeDir("bin"), true);
    assert.equal(shouldExcludeDir("obj"), true);
    assert.equal(shouldExcludeDir("node_modules"), true);
  });

  it("excludes any dot-prefixed directory name", () => {
    assert.equal(shouldExcludeDir(".vs"), true);
    assert.equal(shouldExcludeDir(".git"), true);
    assert.equal(shouldExcludeDir(".foo"), true);
  });

  it("does not exclude ordinary directory names", () => {
    assert.equal(shouldExcludeDir("src"), false);
    assert.equal(shouldExcludeDir("Controllers"), false);
  });
});

describe("listDirectChildren", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-disk-scanner-"));
    fs.mkdirSync(path.join(tempDir, "bin"));
    fs.mkdirSync(path.join(tempDir, "obj"));
    fs.mkdirSync(path.join(tempDir, ".vs"));
    fs.mkdirSync(path.join(tempDir, ".hidden"));
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    fs.mkdirSync(path.join(tempDir, "Controllers"));
    fs.writeFileSync(path.join(tempDir, "Program.cs"), "");
    fs.writeFileSync(path.join(tempDir, "App.csproj"), "");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("excludes bin/obj/.vs/.hidden/node_modules directories", () => {
    const entries = listDirectChildren(tempDir);
    const names = entries.map((entry) => entry.name);

    assert.equal(names.includes("bin"), false);
    assert.equal(names.includes("obj"), false);
    assert.equal(names.includes(".vs"), false);
    assert.equal(names.includes(".hidden"), false);
    assert.equal(names.includes("node_modules"), false);
  });

  it("returns folders before files, each group sorted alphabetically", () => {
    const entries = listDirectChildren(tempDir);

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["Controllers", "App.csproj", "Program.cs"],
    );
    assert.equal(entries[0].kind, "folder");
    assert.equal(entries[1].kind, "file");
    assert.equal(entries[2].kind, "file");
  });
});

describe("listAllFilesRecursive", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-disk-scanner-recursive-"));
    fs.mkdirSync(path.join(tempDir, "bin"));
    fs.mkdirSync(path.join(tempDir, "Generated"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "bin", "Ignored.dll"), "");
    fs.writeFileSync(path.join(tempDir, "Program.cs"), "");
    fs.writeFileSync(path.join(tempDir, "Generated", "Model.cs"), "");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns nested files as POSIX-relative paths", () => {
    const result = listAllFilesRecursive(tempDir).sort();

    assert.deepEqual(result, ["Generated/Model.cs", "Program.cs"]);
  });

  it("excludes files within bin/obj/hidden directories, even when nested", () => {
    const result = listAllFilesRecursive(tempDir);

    assert.equal(result.includes("bin/Ignored.dll"), false);
  });

  it("returns an empty array for a project with no files", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-solution-explorer-disk-scanner-empty-"));
    try {
      assert.deepEqual(listAllFilesRecursive(emptyDir), []);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
