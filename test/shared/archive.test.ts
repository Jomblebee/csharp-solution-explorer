import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { safeJoin } from "../../src/shared/archive.js";

describe("safeJoin", () => {
  it("joins a plain relative path onto the base", () => {
    assert.equal(safeJoin("/tmp/out", "netcoredbg"), path.resolve("/tmp/out/netcoredbg"));
  });

  it("joins a nested relative path", () => {
    assert.equal(safeJoin("/tmp/out", "a/b/c.dll"), path.resolve("/tmp/out/a/b/c.dll"));
  });

  it("rejects a path that escapes the base with ..", () => {
    assert.equal(safeJoin("/tmp/out", "../evil.sh"), undefined);
  });

  it("rejects a deeply nested escape", () => {
    assert.equal(safeJoin("/tmp/out", "a/../../../etc/passwd"), undefined);
  });

  it("rejects an absolute path that would leave the base", () => {
    assert.equal(safeJoin("/tmp/out", "/etc/passwd"), undefined);
  });

  it("allows a .. that stays inside the base", () => {
    assert.equal(safeJoin("/tmp/out", "a/../b"), path.resolve("/tmp/out/b"));
  });

  it("returns the base unchanged for an empty relative path", () => {
    // Callers filter the prefix-root entry out before this point, so the base itself is allowed.
    assert.equal(safeJoin("/tmp/out", ""), path.resolve("/tmp/out"));
  });

  it("does not treat a sibling directory with a shared prefix as inside the base", () => {
    assert.equal(safeJoin("/tmp/out", "../out-evil/x"), undefined);
  });
});
