import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFqnFilter, buildTestArgs, parseTestHostPid } from "../../src/testExplorer/dotnetTestArgs.js";

describe("buildTestArgs", () => {
  it("always logs trx into the results directory", () => {
    const args = buildTestArgs("/repo/A.csproj", "/tmp/out");
    assert.deepEqual(args, ["test", "/repo/A.csproj", "--logger", "trx", "--results-directory", "/tmp/out", "--nologo"]);
  });

  it("leaves verbosity alone at the full level", () => {
    const args = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, undefined, undefined, "full");
    assert.ok(!args.includes("-v:q"));
    assert.ok(!args.some((arg) => arg.startsWith("console;")));
  });

  it("quiets MSBuild and sets the console logger explicitly below the full level", () => {
    const summary = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, undefined, undefined, "summary");
    assert.ok(summary.includes("-v:q"));
    assert.ok(summary.includes("console;verbosity=quiet"));
    const normal = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, undefined, undefined, "normal");
    assert.ok(normal.includes("-v:q"));
    assert.ok(normal.includes("console;verbosity=normal"));
  });

  it("keeps the trx logger alongside the console logger, since results are parsed from it", () => {
    const args = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, undefined, undefined, "summary");
    assert.equal(args.filter((arg) => arg === "--logger").length, 2);
    assert.ok(args.includes("trx"));
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

  it("adds the coverage collector only when coverage is requested", () => {
    assert.ok(!buildTestArgs("/repo/A.csproj", "/tmp/out").includes("--collect"));
    const covered = buildTestArgs("/repo/A.csproj", "/tmp/out", undefined, undefined, true);
    assert.deepEqual(covered.slice(-2), ["--collect", "XPlat Code Coverage"]);
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
