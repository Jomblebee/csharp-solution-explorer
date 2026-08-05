import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureMsbuild, maxCpuArgs, msbuildEnv, msbuildNodeEnv, resetMsbuildConfig } from "../../src/shared/msbuild.js";

afterEach(() => resetMsbuildConfig());

describe("msbuildNodeEnv", () => {
  it("disables node reuse before anything configured it", () => {
    assert.deepEqual(msbuildNodeEnv(), { MSBUILDDISABLENODEREUSE: "1" });
  });

  it("stays out of the way when the user opts into reuse", () => {
    configureMsbuild({ reuseNodes: true, maxCpuCount: 0 });
    assert.deepEqual(msbuildNodeEnv(), {});
  });

  it("keeps the caller's environment and adds the override", () => {
    const env = msbuildEnv({ PATH: "/usr/bin", MSBUILDDISABLENODEREUSE: "0" });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.MSBUILDDISABLENODEREUSE, "1");
  });

  it("leaves an existing MSBUILDDISABLENODEREUSE alone once reuse is allowed", () => {
    configureMsbuild({ reuseNodes: true });
    assert.equal(msbuildEnv({ MSBUILDDISABLENODEREUSE: "0" }).MSBUILDDISABLENODEREUSE, "0");
  });
});

describe("maxCpuArgs", () => {
  it("passes no switch when uncapped", () => {
    configureMsbuild({ reuseNodes: false, maxCpuCount: 0 });
    assert.deepEqual(maxCpuArgs(), []);
  });

  it("emits -m:N for a cap", () => {
    configureMsbuild({ maxCpuCount: 4 });
    assert.deepEqual(maxCpuArgs(), ["-m:4"]);
  });

  it("truncates a fractional cap rather than emitting -m:2.5", () => {
    configureMsbuild({ maxCpuCount: 2.5 });
    assert.deepEqual(maxCpuArgs(), ["-m:2"]);
  });

  it("treats a negative or non-numeric cap as uncapped", () => {
    configureMsbuild({ maxCpuCount: -3 });
    assert.deepEqual(maxCpuArgs(), []);
    configureMsbuild({ maxCpuCount: Number.NaN });
    assert.deepEqual(maxCpuArgs(), []);
  });

  it("resets to the defaults when settings are re-applied without the keys", () => {
    configureMsbuild({ reuseNodes: true, maxCpuCount: 8 });
    configureMsbuild({});
    assert.deepEqual(maxCpuArgs(), []);
    assert.deepEqual(msbuildNodeEnv(), { MSBUILDDISABLENODEREUSE: "1" });
  });
});
