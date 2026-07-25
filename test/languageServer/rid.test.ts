import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRid } from "../../src/languageServer/rid.js";

describe("detectRid", () => {
  it("maps supported platform/arch pairs to RIDs", () => {
    assert.equal(detectRid("win32", "x64"), "win-x64");
    assert.equal(detectRid("win32", "arm64"), "win-arm64");
    assert.equal(detectRid("linux", "x64"), "linux-x64");
    assert.equal(detectRid("linux", "arm64"), "linux-arm64");
    assert.equal(detectRid("darwin", "x64"), "osx-x64");
    assert.equal(detectRid("darwin", "arm64"), "osx-arm64");
  });

  it("returns undefined for unsupported platforms or architectures", () => {
    assert.equal(detectRid("sunos", "x64"), undefined);
    assert.equal(detectRid("linux", "ia32"), undefined);
    assert.equal(detectRid("win32", "ppc64"), undefined);
    assert.equal(detectRid("darwin", "ia32"), undefined);
  });
});
