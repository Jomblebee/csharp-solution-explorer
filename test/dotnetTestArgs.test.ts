import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFqnFilter, buildTestArgs, parseTestHostPid } from "../src/testExplorer/dotnetTestArgs.js";

describe("buildTestArgs", () => {
  it("always logs trx into the results directory", () => {
    const args = buildTestArgs("/repo/A.csproj", "/tmp/out");
    assert.deepEqual(args, ["test", "/repo/A.csproj", "--logger", "trx", "--results-directory", "/tmp/out"]);
  });

  it("adds -f only when a framework is given", () => {
    assert.ok(!buildTestArgs("/repo/A.csproj", "/tmp/out").includes("-f"));
    const multi = buildTestArgs("/repo/A.csproj", "/tmp/out", "net10.0");
    assert.ok(multi.includes("-f") && multi.includes("net10.0"));
  });

  it("adds --filter only when a filter is given", () => {
    assert.ok(!buildTestArgs("/repo/A.csproj", "/tmp/out").includes("--filter"));
    const filtered = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, "FullyQualifiedName=Ns.C.A");
    assert.deepEqual(filtered.slice(-2), ["--filter", "FullyQualifiedName=Ns.C.A"]);
  });
});

describe("buildFqnFilter", () => {
  it("joins FQNs and strips data-driven suffixes", () => {
    assert.equal(buildFqnFilter(["Ns.C.A", "Ns.C.B(x: 1)"]), "FullyQualifiedName=Ns.C.A|FullyQualifiedName=Ns.C.B");
  });

  it("returns undefined for an empty selection", () => {
    assert.equal(buildFqnFilter([]), undefined);
    assert.equal(buildFqnFilter([""]), undefined);
  });
});

describe("parseTestHostPid", () => {
  it("reads the PID from the test-host banner line", () => {
    assert.equal(parseTestHostPid("Process Id: 12345, Name: testhost"), 12345);
  });

  it("returns undefined for an unrelated line", () => {
    assert.equal(parseTestHostPid("Determining projects to restore..."), undefined);
  });
});
