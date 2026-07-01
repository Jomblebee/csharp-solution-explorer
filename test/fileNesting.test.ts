import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeFileNesting } from "../src/solutionExplorer/fileNesting.js";
import { ScannedEntry } from "../src/solutionExplorer/diskScanner.js";

function file(name: string): ScannedEntry {
  return { kind: "file", name, path: `/proj/${name}` };
}

function folder(name: string): ScannedEntry {
  return { kind: "folder", name, path: `/proj/${name}` };
}

/** Convenience: names (lowercased) of the children nested under `parent`. */
function childNamesOf(entries: ScannedEntry[], parent: string): string[] {
  const { childrenByParent } = computeFileNesting(entries);
  return (childrenByParent.get(parent.toLowerCase()) ?? []).map((e) => e.name);
}

describe("computeFileNesting — appsettings", () => {
  it("nests appsettings.<env>.json under appsettings.json, sorted", () => {
    const entries = [
      file("appsettings.json"),
      file("appsettings.Production.json"),
      file("appsettings.Development.json"),
    ];
    const { childrenByParent, nestedChildNames } = computeFileNesting(entries);

    assert.deepEqual(
      childrenByParent.get("appsettings.json")?.map((e) => e.name),
      ["appsettings.Development.json", "appsettings.Production.json"],
    );
    assert.ok(nestedChildNames.has("appsettings.development.json"));
    assert.ok(nestedChildNames.has("appsettings.production.json"));
    assert.ok(!nestedChildNames.has("appsettings.json"));
  });

  it("does not nest ordinary <name>.<x>.json pairs", () => {
    const entries = [file("config.json"), file("config.local.json")];
    const { childrenByParent, nestedChildNames } = computeFileNesting(entries);
    assert.equal(childrenByParent.size, 0);
    assert.equal(nestedChildNames.size, 0);
  });

  it("leaves appsettings variants flat when the base file is missing", () => {
    const entries = [file("appsettings.Development.json"), file("appsettings.Production.json")];
    const { childrenByParent, nestedChildNames } = computeFileNesting(entries);
    assert.equal(childrenByParent.size, 0);
    assert.equal(nestedChildNames.size, 0);
  });
});

describe("computeFileNesting — xaml / resx / minified", () => {
  it("nests .xaml.cs code-behind under .xaml", () => {
    assert.deepEqual(childNamesOf([file("MainWindow.xaml"), file("MainWindow.xaml.cs")], "MainWindow.xaml"), [
      "MainWindow.xaml.cs",
    ]);
  });

  it("nests Designer.cs and .cs under a .resx", () => {
    const entries = [file("Resources.resx"), file("Resources.Designer.cs"), file("Resources.cs")];
    assert.deepEqual(childNamesOf(entries, "Resources.resx"), ["Resources.cs", "Resources.Designer.cs"]);
  });

  it("nests minified css/js under their source", () => {
    const entries = [file("site.css"), file("site.min.css"), file("bundle.js"), file("bundle.min.js")];
    assert.deepEqual(childNamesOf(entries, "site.css"), ["site.min.css"]);
    assert.deepEqual(childNamesOf(entries, "bundle.js"), ["bundle.min.js"]);
    // The minified files themselves must not be treated as parents.
    const { childrenByParent } = computeFileNesting(entries);
    assert.ok(!childrenByParent.has("site.min.css"));
  });
});

describe("computeFileNesting — razor regression", () => {
  it("nests razor companions under the .razor file", () => {
    const entries = [
      file("Counter.razor"),
      file("Counter.razor.cs"),
      file("Counter.razor.css"),
      file("Counter.razor.js"),
    ];
    assert.deepEqual(childNamesOf(entries, "Counter.razor"), [
      "Counter.razor.cs",
      "Counter.razor.css",
      "Counter.razor.js",
    ]);
  });

  it("attaches a shared companion to the longest matching parent", () => {
    // "Foo.razor.cs" could match "Foo" prefixes but must attach to "Foo.razor".
    const entries = [file("Foo.razor"), file("Foo.razor.cs")];
    const { childrenByParent } = computeFileNesting(entries);
    assert.deepEqual(childrenByParent.get("foo.razor")?.map((e) => e.name), ["Foo.razor.cs"]);
    assert.ok(!childrenByParent.has("foo.razor.cs"));
  });
});

describe("computeFileNesting — general", () => {
  it("is case-insensitive on the base name", () => {
    const entries = [file("AppSettings.json"), file("AppSettings.Development.json")];
    assert.deepEqual(childNamesOf(entries, "appsettings.json"), ["AppSettings.Development.json"]);
  });

  it("ignores folders as parents and children", () => {
    const entries = [folder("appsettings.json"), file("appsettings.Development.json")];
    const { childrenByParent, nestedChildNames } = computeFileNesting(entries);
    assert.equal(childrenByParent.size, 0);
    assert.equal(nestedChildNames.size, 0);
  });

  it("returns nothing for unrelated files", () => {
    const entries = [file("Program.cs"), file("README.md"), folder("Models")];
    const { childrenByParent, nestedChildNames } = computeFileNesting(entries);
    assert.equal(childrenByParent.size, 0);
    assert.equal(nestedChildNames.size, 0);
  });
});
