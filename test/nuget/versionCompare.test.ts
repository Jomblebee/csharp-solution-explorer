import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../../src/nuget/versionCompare.js";

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    assert.ok(compareVersions("9.0.0", "9.6.0") < 0);
    assert.ok(compareVersions("13.0.3", "13.0.1") > 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("treats differing segment counts as length-tolerant", () => {
    assert.equal(compareVersions("9.0", "9.0.0"), 0);
    assert.ok(compareVersions("9.0", "9.0.1") < 0);
  });

  it("sorts a pre-release below the stable release it precedes", () => {
    // Without this, anyone on a preview would never be offered the stable version.
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.0") < 0);
    assert.ok(compareVersions("9.0.0", "9.0.0-rc.1") > 0);
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.1") < 0);
    assert.ok(compareVersions("9.0.0-rc.1", "8.9.0") > 0);
  });

  it("orders pre-release labels per SemVer", () => {
    assert.equal(compareVersions("9.0.0-rc.1", "9.0.0-rc.1"), 0);
    assert.ok(compareVersions("9.0.0-alpha", "9.0.0-beta") < 0);
    assert.ok(compareVersions("9.0.0-rc.2", "9.0.0-rc.10") < 0); // numeric, not lexical
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.0-rc.1.1") < 0); // longer label wins on a tie
    assert.ok(compareVersions("9.0.0-1", "9.0.0-alpha") < 0); // numeric sorts below alphanumeric
  });

  it("ignores build metadata", () => {
    assert.equal(compareVersions("9.0.0+build.5", "9.0.0"), 0);
    assert.equal(compareVersions("9.0.0-rc.1+build.5", "9.0.0-rc.1"), 0);
  });

  it("treats non-numeric segments as zero", () => {
    assert.equal(compareVersions("9.x", "9.0"), 0);
  });
});
