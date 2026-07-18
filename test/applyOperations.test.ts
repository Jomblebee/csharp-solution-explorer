import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApplyProgress,
  applyPackageWith,
  applyUpdatesWith,
  PackageOps,
} from "../src/nuget/applyOperations.js";

/**
 * Fake `dotnet` operations that record every call in order, so tests can assert not just the results
 * but that the CLI was (or was not) invoked. `failFor` names the project paths whose `add` rejects.
 */
function fakeOps(options: { failFor?: Record<string, unknown> } = {}): PackageOps & { calls: string[] } {
  const calls: string[] = [];
  const failFor = options.failFor ?? {};
  return {
    calls,
    async add(fsPath, id, version) {
      calls.push(`add:${fsPath}:${id}:${version ?? "-"}`);
      if (fsPath in failFor) {
        throw failFor[fsPath];
      }
    },
    async remove(fsPath, id) {
      calls.push(`remove:${fsPath}:${id}`);
      if (fsPath in failFor) {
        throw failFor[fsPath];
      }
    },
    async restore(fsPath) {
      calls.push(`restore:${fsPath}`);
    },
  };
}

const projects = [
  { name: "App", fsPath: "/repo/App/App.csproj" },
  { name: "Lib", fsPath: "/repo/Lib/Lib.csproj" },
];

/** A cancellation token that flips to cancelled after `after` progress reports. */
function cancelAfter(after: number): { token: { isCancellationRequested: boolean }; report: () => void } {
  const token = { isCancellationRequested: false };
  let seen = 0;
  return {
    token,
    report: () => {
      if (++seen >= after) {
        token.isCancellationRequested = true;
      }
    },
  };
}

describe("applyPackageWith", () => {
  it("adds the package once per project for install and update", async () => {
    for (const op of ["install", "update"] as const) {
      const ops = fakeOps();
      const results = await applyPackageWith(ops, op, "Serilog", "3.1.1", projects);
      assert.deepEqual(ops.calls, [
        "add:/repo/App/App.csproj:Serilog:3.1.1",
        "add:/repo/Lib/Lib.csproj:Serilog:3.1.1",
      ]);
      assert.deepEqual(results, [
        { project: "App", ok: true },
        { project: "Lib", ok: true },
      ]);
    }
  });

  it("removes and then restores for uninstall", async () => {
    const ops = fakeOps();
    await applyPackageWith(ops, "uninstall", "Serilog", undefined, projects);
    assert.deepEqual(ops.calls, [
      "remove:/repo/App/App.csproj:Serilog",
      "restore:/repo/App/App.csproj",
      "remove:/repo/Lib/Lib.csproj:Serilog",
      "restore:/repo/Lib/Lib.csproj",
    ]);
  });

  it("isolates a failing project so the rest still run", async () => {
    const ops = fakeOps({ failFor: { "/repo/App/App.csproj": new Error("dotnet exploded") } });
    const results = await applyPackageWith(ops, "install", "Serilog", "3.1.1", projects);
    assert.deepEqual(results, [
      { project: "App", ok: false, error: "dotnet exploded" },
      { project: "Lib", ok: true },
    ]);
    // The second project was genuinely attempted, not just reported as fine.
    assert.deepEqual(ops.calls, [
      "add:/repo/App/App.csproj:Serilog:3.1.1",
      "add:/repo/Lib/Lib.csproj:Serilog:3.1.1",
    ]);
  });

  it("skips the restore when the uninstall itself failed", async () => {
    const ops = fakeOps({ failFor: { "/repo/App/App.csproj": new Error("nope") } });
    await applyPackageWith(ops, "uninstall", "Serilog", undefined, [projects[0]]);
    assert.deepEqual(ops.calls, ["remove:/repo/App/App.csproj:Serilog"]);
  });

  it("stringifies a thrown non-Error", async () => {
    const ops = fakeOps({ failFor: { "/repo/App/App.csproj": "just a string" } });
    const results = await applyPackageWith(ops, "install", "Serilog", "3.1.1", [projects[0]]);
    assert.deepEqual(results, [{ project: "App", ok: false, error: "just a string" }]);
  });

  it("reports progress once per project, including the failing one", async () => {
    const ops = fakeOps({ failFor: { "/repo/App/App.csproj": new Error("boom") } });
    const seen: ApplyProgress[] = [];
    await applyPackageWith(ops, "install", "Serilog", "3.1.1", projects, (p) => seen.push(p));
    assert.deepEqual(seen, [
      { done: 1, total: 2, id: "Serilog", project: "App" },
      { done: 2, total: 2, id: "Serilog", project: "Lib" },
    ]);
  });

  it("stops before the next project once cancelled", async () => {
    const ops = fakeOps();
    const { token, report } = cancelAfter(1);
    const results = await applyPackageWith(ops, "install", "Serilog", "3.1.1", projects, report, token);
    assert.equal(results.length, 1);
    assert.deepEqual(ops.calls, ["add:/repo/App/App.csproj:Serilog:3.1.1"]);
  });

  it("does nothing at all when the token is already cancelled", async () => {
    const ops = fakeOps();
    const results = await applyPackageWith(ops, "install", "Serilog", "3.1.1", projects, undefined, {
      isCancellationRequested: true,
    });
    assert.deepEqual(results, []);
    assert.deepEqual(ops.calls, []);
  });

  it("passes no version through for an unpinned install", async () => {
    const ops = fakeOps();
    await applyPackageWith(ops, "install", "Serilog", undefined, [projects[0]]);
    assert.deepEqual(ops.calls, ["add:/repo/App/App.csproj:Serilog:-"]);
  });
});

describe("applyUpdatesWith", () => {
  const entries = [
    { id: "Serilog", version: "3.1.1", projects: [projects[0]] },
    { id: "Newtonsoft.Json", version: "13.0.3", projects: [projects[1]] },
  ];

  it("processes packages sequentially and groups the results per package", async () => {
    const ops = fakeOps();
    const results = await applyUpdatesWith(ops, entries);
    assert.deepEqual(ops.calls, [
      "add:/repo/App/App.csproj:Serilog:3.1.1",
      "add:/repo/Lib/Lib.csproj:Newtonsoft.Json:13.0.3",
    ]);
    assert.deepEqual(results, [
      { id: "Serilog", results: [{ project: "App", ok: true }] },
      { id: "Newtonsoft.Json", results: [{ project: "Lib", ok: true }] },
    ]);
  });

  it("counts progress per package, not per project", async () => {
    const ops = fakeOps();
    const seen: ApplyProgress[] = [];
    await applyUpdatesWith(ops, entries, (p) => seen.push(p));
    assert.deepEqual(seen, [
      { done: 1, total: 2, id: "Serilog" },
      { done: 2, total: 2, id: "Newtonsoft.Json" },
    ]);
  });

  it("keeps going after a package fails", async () => {
    const ops = fakeOps({ failFor: { "/repo/App/App.csproj": new Error("boom") } });
    const results = await applyUpdatesWith(ops, entries);
    assert.equal(results[0].results[0].ok, false);
    assert.equal(results[1].results[0].ok, true);
  });

  it("truncates the batch once cancelled", async () => {
    const ops = fakeOps();
    const { token, report } = cancelAfter(1);
    const results = await applyUpdatesWith(ops, entries, report, token);
    assert.deepEqual(results.map((r) => r.id), ["Serilog"]);
    assert.deepEqual(ops.calls, ["add:/repo/App/App.csproj:Serilog:3.1.1"]);
  });

  it("propagates the token into the per-project loop", async () => {
    // Cancelling mid-package must stop the remaining projects of that same package, not just the
    // remaining packages.
    const ops = fakeOps();
    const token = { isCancellationRequested: false };
    const results = await applyUpdatesWith(
      ops,
      [{ id: "Serilog", version: "3.1.1", projects }],
      undefined,
      token,
    );
    assert.equal(results[0].results.length, 2);

    const cancelled = fakeOps();
    token.isCancellationRequested = true;
    const none = await applyUpdatesWith(cancelled, [{ id: "Serilog", version: "3.1.1", projects }], undefined, token);
    assert.deepEqual(none, []);
    assert.deepEqual(cancelled.calls, []);
  });
});
