import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAssetsFilePath, parseProjectAssets } from "../src/solutionExplorer/projectAssetsReader.js";

const assets = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    version: 3,
    targets: {},
    libraries: {},
    project: { frameworks: { "net10.0": {} } },
    ...overrides,
  });

describe("getAssetsFilePath", () => {
  it("points at obj/project.assets.json under the project root", () => {
    assert.equal(getAssetsFilePath("/repo/src/App"), "/repo/src/App/obj/project.assets.json");
  });
});

describe("parseProjectAssets", () => {
  it("returns empty results for invalid JSON", () => {
    assert.deepEqual(parseProjectAssets("{ not json"), { frameworks: [], packages: [], analyzers: [] });
  });

  it("returns empty results when no project frameworks are present", () => {
    assert.deepEqual(parseProjectAssets(JSON.stringify({ project: { frameworks: {} } })), {
      frameworks: [],
      packages: [],
      analyzers: [],
    });
  });

  it("always reports Microsoft.NETCore.App plus explicit framework references", () => {
    const json = assets({
      project: { frameworks: { "net10.0": { frameworkReferences: { "Microsoft.AspNetCore.App": {} } } } },
    });

    assert.deepEqual(parseProjectAssets(json).frameworks, [
      { name: "Microsoft.NETCore.App" },
      { name: "Microsoft.AspNetCore.App" },
    ]);
  });

  it("extracts direct packages and resolves their version from the target", () => {
    const json = assets({
      targets: { "net10.0": { "MudBlazor/9.0.0": { type: "package" } } },
      project: {
        frameworks: { "net10.0": { dependencies: { MudBlazor: { target: "Package", version: "[9.0.0, )" } } } },
      },
    });

    const { packages } = parseProjectAssets(json);

    assert.equal(packages.length, 1);
    assert.equal(packages[0].name, "MudBlazor");
    assert.equal(packages[0].version, "9.0.0");
  });

  it("nests transitive packages under their direct parent", () => {
    const json = assets({
      targets: {
        "net10.0": {
          "MudBlazor/9.0.0": { type: "package", dependencies: { "Microsoft.Extensions.Logging": "10.0.0" } },
          "Microsoft.Extensions.Logging/10.0.0": { type: "package" },
        },
      },
      project: {
        frameworks: { "net10.0": { dependencies: { MudBlazor: { target: "Package", version: "[9.0.0, )" } } } },
      },
    });

    const { packages } = parseProjectAssets(json);

    assert.equal(packages[0].dependencies.length, 1);
    assert.equal(packages[0].dependencies[0].name, "Microsoft.Extensions.Logging");
    assert.equal(packages[0].dependencies[0].version, "10.0.0");
  });

  it("excludes project references from the packages list", () => {
    const json = assets({
      project: {
        frameworks: {
          "net10.0": { dependencies: { "../Lib/Lib.csproj": { target: "Project" } } },
        },
      },
    });

    assert.deepEqual(parseProjectAssets(json).packages, []);
  });

  it("survives dependency cycles without infinite recursion", () => {
    const json = assets({
      targets: {
        "net10.0": {
          "A/1.0.0": { type: "package", dependencies: { B: "1.0.0" } },
          "B/1.0.0": { type: "package", dependencies: { A: "1.0.0" } },
        },
      },
      project: { frameworks: { "net10.0": { dependencies: { A: { target: "Package", version: "1.0.0" } } } } },
    });

    const { packages } = parseProjectAssets(json);

    assert.equal(packages[0].name, "A");
    assert.equal(packages[0].dependencies[0].name, "B");
    // B lists A again, but the cycle guard stops it from re-expanding A's children.
    assert.equal(packages[0].dependencies[0].dependencies[0].name, "A");
    assert.deepEqual(packages[0].dependencies[0].dependencies[0].dependencies, []);
  });

  it("detects analyzer assemblies from library files", () => {
    const json = assets({
      libraries: {
        "Microsoft.CodeAnalysis.NetAnalyzers/8.0.0": {
          type: "package",
          files: ["analyzers/dotnet/cs/Microsoft.CodeAnalysis.CSharp.NetAnalyzers.dll", "lib/netstandard2.0/x.dll"],
        },
        "Newtonsoft.Json/13.0.3": { type: "package", files: ["lib/net6.0/Newtonsoft.Json.dll"] },
      },
    });

    assert.deepEqual(parseProjectAssets(json).analyzers, [
      { name: "Microsoft.CodeAnalysis.CSharp.NetAnalyzers", version: "8.0.0" },
    ]);
  });
});
