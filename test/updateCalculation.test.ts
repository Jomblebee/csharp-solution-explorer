import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUpdates, highestInstalledVersions } from "../src/nuget/updateCalculation.js";

/** Builds a `getLatest` stub from a lookup table; unknown ids resolve to `undefined`. */
function latestFrom(table: Record<string, string>): (id: string) => Promise<string | undefined> {
  return async (id) => table[id.toLowerCase()];
}

describe("highestInstalledVersions", () => {
  it("keeps the highest version across projects", () => {
    const result = highestInstalledVersions([
      { packages: [{ id: "Serilog", version: "2.10.0" }] },
      { packages: [{ id: "Serilog", version: "3.1.1" }] },
      { packages: [{ id: "Serilog", version: "2.12.0" }] },
    ]);
    assert.deepEqual(result, [{ id: "Serilog", version: "3.1.1" }]);
  });

  it("treats package ids case-insensitively but keeps the first-seen spelling", () => {
    const result = highestInstalledVersions([
      { packages: [{ id: "Serilog", version: "2.10.0" }] },
      { packages: [{ id: "SERILOG", version: "3.1.1" }] },
    ]);
    assert.deepEqual(result, [{ id: "Serilog", version: "3.1.1" }]);
  });

  it("returns one entry per distinct package", () => {
    const result = highestInstalledVersions([
      { packages: [{ id: "A", version: "1.0.0" }, { id: "B", version: "2.0.0" }] },
      { packages: [{ id: "B", version: "1.0.0" }, { id: "C", version: "3.0.0" }] },
    ]);
    assert.deepEqual(result.map((r) => r.id).sort(), ["A", "B", "C"]);
  });

  it("handles no projects and projects without packages", () => {
    assert.deepEqual(highestInstalledVersions([]), []);
    assert.deepEqual(highestInstalledVersions([{ packages: [] }]), []);
  });
});

describe("computeUpdates", () => {
  const projects = [
    { packages: [{ id: "Serilog", version: "2.10.0" }, { id: "Newtonsoft.Json", version: "13.0.3" }] },
    { packages: [{ id: "Serilog", version: "3.0.0" }] },
  ];

  it("flags only packages whose highest installed version is behind", async () => {
    const updates = await computeUpdates(
      projects,
      latestFrom({ serilog: "3.1.1", "newtonsoft.json": "13.0.3" }),
    );
    assert.deepEqual(updates, [{ id: "Serilog", installed: "3.0.0", latest: "3.1.1" }]);
  });

  it("offers the stable release to a project sitting on a pre-release", async () => {
    const updates = await computeUpdates(
      [{ packages: [{ id: "Serilog", version: "3.1.1-dev-02full" }] }],
      latestFrom({ serilog: "3.1.1" }),
    );
    assert.deepEqual(updates, [{ id: "Serilog", installed: "3.1.1-dev-02full", latest: "3.1.1" }]);
  });

  it("does not flag a package that is already newer than the latest stable", async () => {
    const updates = await computeUpdates(
      [{ packages: [{ id: "Serilog", version: "4.0.0-beta" }] }],
      latestFrom({ serilog: "3.1.1" }),
    );
    assert.deepEqual(updates, []);
  });

  it("skips packages whose lookup fails instead of failing the whole check", async () => {
    const updates = await computeUpdates(projects, async (id) => {
      if (id === "Serilog") {
        throw new Error("network down");
      }
      return "14.0.0";
    });
    assert.deepEqual(updates, [{ id: "Newtonsoft.Json", installed: "13.0.3", latest: "14.0.0" }]);
  });

  it("skips packages with no known latest version", async () => {
    assert.deepEqual(await computeUpdates(projects, latestFrom({})), []);
  });

  it("sorts results by package id", async () => {
    const updates = await computeUpdates(
      [{ packages: [{ id: "Zed", version: "1.0.0" }, { id: "Alpha", version: "1.0.0" }] }],
      latestFrom({ zed: "2.0.0", alpha: "2.0.0" }),
    );
    assert.deepEqual(updates.map((u) => u.id), ["Alpha", "Zed"]);
  });
});
