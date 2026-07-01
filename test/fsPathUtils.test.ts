import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { isInsideOrEqual, pickOwningProjectPath, resolveCopyDestName } from "../src/solutionExplorer/fsPathUtils.js";

const p = (...segments: string[]) => path.join(path.sep, ...segments);

describe("isInsideOrEqual", () => {
  it("treats an identical path as inside", () => {
    assert.equal(isInsideOrEqual(p("a", "b"), p("a", "b")), true);
  });

  it("recognises a nested path", () => {
    assert.equal(isInsideOrEqual(p("a", "b", "c"), p("a", "b")), true);
  });

  it("rejects a sibling with a shared prefix", () => {
    assert.equal(isInsideOrEqual(p("a", "bc"), p("a", "b")), false);
  });

  it("rejects an unrelated path", () => {
    assert.equal(isInsideOrEqual(p("x", "y"), p("a", "b")), false);
  });
});

describe("pickOwningProjectPath", () => {
  it("returns the longest matching project root", () => {
    const roots = [p("sln", "App"), p("sln", "App", "Sub")];
    assert.equal(pickOwningProjectPath(roots, p("sln", "App", "Sub", "File.cs")), p("sln", "App", "Sub"));
  });

  it("returns undefined when the file is outside every root", () => {
    const roots = [p("sln", "App"), p("sln", "Lib")];
    assert.equal(pickOwningProjectPath(roots, p("other", "File.cs")), undefined);
  });

  it("matches a file directly in a project root", () => {
    const roots = [p("sln", "App")];
    assert.equal(pickOwningProjectPath(roots, p("sln", "App", "Program.cs")), p("sln", "App"));
  });
});

describe("resolveCopyDestName", () => {
  const taken = (...names: string[]) => (candidate: string) => names.includes(candidate);

  it("keeps the original name when free", () => {
    assert.equal(resolveCopyDestName("File.cs", false, taken()), "File.cs");
  });

  it("inserts ' copy' before the extension on collision", () => {
    assert.equal(resolveCopyDestName("File.cs", false, taken("File.cs")), "File copy.cs");
  });

  it("increments the copy counter while names are taken", () => {
    assert.equal(
      resolveCopyDestName("File.cs", false, taken("File.cs", "File copy.cs", "File copy 2.cs")),
      "File copy 3.cs",
    );
  });

  it("uses the last extension only for multi-dot names", () => {
    assert.equal(resolveCopyDestName("archive.tar.gz", false, taken("archive.tar.gz")), "archive.tar copy.gz");
  });

  it("appends ' copy' to directories without touching an extension", () => {
    assert.equal(resolveCopyDestName("src", true, taken("src")), "src copy");
  });

  it("does not treat a dotfile's leading dot as an extension", () => {
    assert.equal(resolveCopyDestName(".gitignore", false, taken(".gitignore")), ".gitignore copy");
  });
});
