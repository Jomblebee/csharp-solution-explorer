import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateInstalled,
  computeConsolidation,
  installedVersionInProject,
  projectsBelowVersion,
  projectsNotAtVersion,
  projectsWithPackage,
} from "../src/nuget/installedView.js";

const project = (name: string, packages: Record<string, string>) => ({
  name,
  fsPath: `/repo/${name}/${name}.csproj`,
  packages: Object.entries(packages).map(([id, version]) => ({ id, version })),
});

const names = (refs: { name: string }[]) => refs.map((ref) => ref.name);

describe("installedVersionInProject", () => {
  it("finds the package regardless of casing", () => {
    const app = project("App", { Serilog: "3.1.1" });
    assert.equal(installedVersionInProject(app, "serilog"), "3.1.1");
    assert.equal(installedVersionInProject(app, "SERILOG"), "3.1.1");
  });

  it("returns undefined when the project does not reference it", () => {
    assert.equal(installedVersionInProject(project("App", {}), "Serilog"), undefined);
  });
});

describe("projectsWithPackage", () => {
  it("keeps only the projects that reference the package, case-insensitively", () => {
    const projects = [project("App", { serilog: "3.1.1" }), project("Lib", { "Newtonsoft.Json": "13.0.3" })];
    assert.deepEqual(names(projectsWithPackage(projects, "Serilog")), ["App"]);
  });

  it("returns the name and path only", () => {
    assert.deepEqual(projectsWithPackage([project("App", { Serilog: "3.1.1" })], "Serilog"), [
      { name: "App", fsPath: "/repo/App/App.csproj" },
    ]);
  });
});

describe("projectsBelowVersion", () => {
  const projects = [
    project("Old", { Serilog: "2.0.0" }),
    project("Current", { Serilog: "3.1.1" }),
    project("Ahead", { Serilog: "4.0.0" }),
    project("Absent", {}),
  ];

  it("selects only the projects strictly below the target", () => {
    assert.deepEqual(names(projectsBelowVersion(projects, "Serilog", "3.1.1")), ["Old"]);
  });

  it("never selects a project that is ahead of the target", () => {
    // An update must not walk a project backwards.
    assert.deepEqual(names(projectsBelowVersion(projects, "Serilog", "2.0.0")), []);
  });

  it("treats 9.0 and 9.0.0 as the same version", () => {
    // Regression: a string comparison flagged these as differing and fired a no-op `dotnet add`.
    const pinned = [project("App", { Serilog: "9.0" })];
    assert.deepEqual(projectsBelowVersion(pinned, "Serilog", "9.0.0"), []);
  });
});

describe("projectsNotAtVersion", () => {
  const projects = [
    project("Old", { Serilog: "2.0.0" }),
    project("Current", { Serilog: "3.1.1" }),
    project("Ahead", { Serilog: "4.0.0" }),
    project("Absent", {}),
  ];

  it("selects projects both below and above the target", () => {
    // Consolidating onto a version must be able to downgrade the projects sitting above it.
    assert.deepEqual(names(projectsNotAtVersion(projects, "Serilog", "3.1.1")), ["Old", "Ahead"]);
  });

  it("excludes projects already on the target, including an equivalent spelling", () => {
    const pinned = [project("App", { Serilog: "9.0" }), project("Lib", { Serilog: "8.0.0" })];
    assert.deepEqual(names(projectsNotAtVersion(pinned, "Serilog", "9.0.0")), ["Lib"]);
  });
});

describe("aggregateInstalled", () => {
  it("groups by case-insensitive id, keeping the first-seen spelling", () => {
    const entries = aggregateInstalled([
      project("App", { Serilog: "3.1.1" }),
      project("Lib", { serilog: "3.1.1" }),
    ]);
    assert.deepEqual(entries, [{ id: "Serilog", versions: ["3.1.1"], projects: 2 }]);
  });

  it("lists distinct versions newest first", () => {
    const entries = aggregateInstalled([
      project("A", { Serilog: "2.0.0" }),
      project("B", { Serilog: "4.0.0" }),
      project("C", { Serilog: "3.1.1" }),
    ]);
    assert.deepEqual(entries[0].versions, ["4.0.0", "3.1.1", "2.0.0"]);
    assert.equal(entries[0].projects, 3);
  });

  it("collapses equivalent version spellings into one", () => {
    const entries = aggregateInstalled([project("A", { Serilog: "9.0" }), project("B", { Serilog: "9.0.0" })]);
    assert.deepEqual(entries[0].versions, ["9.0"]);
  });

  it("sorts entries by package id", () => {
    const entries = aggregateInstalled([project("App", { Zzz: "1.0.0", Aaa: "1.0.0" })]);
    assert.deepEqual(entries.map((e) => e.id), ["Aaa", "Zzz"]);
  });

  it("returns nothing for a solution with no packages", () => {
    assert.deepEqual(aggregateInstalled([]), []);
    assert.deepEqual(aggregateInstalled([project("App", {})]), []);
  });
});

describe("computeConsolidation", () => {
  it("reports only packages sitting at more than one version", () => {
    const entries = computeConsolidation([
      project("App", { Serilog: "3.1.1", "Newtonsoft.Json": "13.0.3" }),
      project("Lib", { Serilog: "2.0.0", "Newtonsoft.Json": "13.0.3" }),
    ]);
    assert.deepEqual(entries.map((e) => e.id), ["Serilog"]);
  });

  it("lists each version newest first with the projects on it", () => {
    const entries = computeConsolidation([
      project("App", { Serilog: "2.0.0" }),
      project("Lib", { Serilog: "3.1.1" }),
      project("Tests", { Serilog: "2.0.0" }),
    ]);
    assert.deepEqual(
      entries[0].versions.map((v) => ({ version: v.version, projects: names(v.projects) })),
      [
        { version: "3.1.1", projects: ["Lib"] },
        { version: "2.0.0", projects: ["App", "Tests"] },
      ],
    );
  });

  it("does not report a package whose versions only differ in spelling", () => {
    const entries = computeConsolidation([project("App", { Serilog: "9.0" }), project("Lib", { Serilog: "9.0.0" })]);
    assert.deepEqual(entries, []);
  });

  it("groups an equivalently-spelled project under the collapsed version", () => {
    const entries = computeConsolidation([
      project("App", { Serilog: "9.0" }),
      project("Lib", { Serilog: "9.0.0" }),
      project("Old", { Serilog: "8.0.0" }),
    ]);
    assert.deepEqual(
      entries[0].versions.map((v) => ({ version: v.version, projects: names(v.projects) })),
      [
        { version: "9.0", projects: ["App", "Lib"] },
        { version: "8.0.0", projects: ["Old"] },
      ],
    );
  });

  it("sorts entries by package id and groups ids case-insensitively", () => {
    const entries = computeConsolidation([
      project("App", { Zzz: "1.0.0", serilog: "2.0.0" }),
      project("Lib", { Zzz: "2.0.0", Serilog: "3.1.1" }),
    ]);
    assert.deepEqual(entries.map((e) => e.id), ["Zzz", "serilog"].sort((a, b) => a.localeCompare(b)));
  });

  it("returns nothing when every package is consistent", () => {
    assert.deepEqual(computeConsolidation([project("App", { Serilog: "3.1.1" })]), []);
  });
});
