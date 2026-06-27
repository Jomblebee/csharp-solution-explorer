import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isImplicitItemGlobEnabled,
  parseItemRules,
  parsePackageReferences,
  parseProjectReferences,
  resolveExcludedPaths,
} from "../src/solutionExplorer/csprojReader.js";

describe("parsePackageReferences", () => {
  it("extracts name and version", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`;

    const result = parsePackageReferences(csproj);

    assert.deepEqual(result, [{ name: "Newtonsoft.Json", version: "13.0.3" }]);
  });

  it("handles missing Version (central package management)", () => {
    const csproj = `<ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup>`;

    const result = parsePackageReferences(csproj);

    assert.deepEqual(result, [{ name: "Newtonsoft.Json", version: undefined }]);
  });

  it("handles attribute order variations", () => {
    const csproj = `<PackageReference Version="1.2.3" Include="SomePackage" />`;

    const result = parsePackageReferences(csproj);

    assert.deepEqual(result, [{ name: "SomePackage", version: "1.2.3" }]);
  });

  it("extracts multiple entries", () => {
    const csproj = `<ItemGroup>
  <PackageReference Include="A" Version="1.0.0" />
  <PackageReference Include="B" Version="2.0.0" />
</ItemGroup>`;

    const result = parsePackageReferences(csproj);

    assert.equal(result.length, 2);
    assert.equal(result[0].name, "A");
    assert.equal(result[1].name, "B");
  });

  it("returns an empty array when there are no PackageReference elements", () => {
    const result = parsePackageReferences(`<Project Sdk="Microsoft.NET.Sdk"></Project>`);

    assert.deepEqual(result, []);
  });
});

describe("parseProjectReferences", () => {
  it("extracts and normalizes Windows-style backslash paths", () => {
    const csproj = `<ItemGroup><ProjectReference Include="..\\Foo\\Foo.csproj" /></ItemGroup>`;

    const result = parseProjectReferences(csproj);

    assert.deepEqual(result, [{ relativePath: "../Foo/Foo.csproj" }]);
  });

  it("extracts multiple entries", () => {
    const csproj = `<ItemGroup>
  <ProjectReference Include="../A/A.csproj" />
  <ProjectReference Include="../B/B.csproj" />
</ItemGroup>`;

    const result = parseProjectReferences(csproj);

    assert.equal(result.length, 2);
    assert.equal(result[0].relativePath, "../A/A.csproj");
    assert.equal(result[1].relativePath, "../B/B.csproj");
  });

  it("returns an empty array when there are no ProjectReference elements", () => {
    const result = parseProjectReferences(`<Project Sdk="Microsoft.NET.Sdk"></Project>`);

    assert.deepEqual(result, []);
  });
});

describe("parseItemRules", () => {
  it("extracts a single Include rule", () => {
    const csproj = `<ItemGroup><Compile Include="Foo.cs" /></ItemGroup>`;

    assert.deepEqual(parseItemRules(csproj), [{ itemType: "Compile", attribute: "Include", pattern: "Foo.cs" }]);
  });

  it("extracts Remove and Exclude rules", () => {
    const csproj = `<ItemGroup>
      <Compile Remove="Generated/**/*.cs" />
      <None Exclude="Drafts/**/*.md" />
    </ItemGroup>`;

    assert.deepEqual(parseItemRules(csproj), [
      { itemType: "Compile", attribute: "Remove", pattern: "Generated/**/*.cs" },
      { itemType: "None", attribute: "Exclude", pattern: "Drafts/**/*.md" },
    ]);
  });

  it("splits semicolon-delimited multi-pattern attributes and normalizes backslashes", () => {
    const csproj = `<Compile Remove="A.cs;Sub\\B.cs; C.cs " />`;

    assert.deepEqual(parseItemRules(csproj), [
      { itemType: "Compile", attribute: "Remove", pattern: "A.cs" },
      { itemType: "Compile", attribute: "Remove", pattern: "Sub/B.cs" },
      { itemType: "Compile", attribute: "Remove", pattern: "C.cs" },
    ]);
  });

  it("tolerates attribute order variation", () => {
    const csproj = `<Content Exclude="Old.json" Include="New.json" />`;
    const result = parseItemRules(csproj);

    assert.equal(result.length, 2);
    assert.deepEqual(result.find((r) => r.attribute === "Include"), {
      itemType: "Content",
      attribute: "Include",
      pattern: "New.json",
    });
  });

  it("preserves document order across multiple elements of the same item type", () => {
    const csproj = `<ItemGroup>
      <Compile Remove="Generated/*.cs" />
      <Compile Include="Generated/Keep.cs" />
    </ItemGroup>`;

    assert.deepEqual(parseItemRules(csproj), [
      { itemType: "Compile", attribute: "Remove", pattern: "Generated/*.cs" },
      { itemType: "Compile", attribute: "Include", pattern: "Generated/Keep.cs" },
    ]);
  });

  it("returns an empty array when there are no Compile/None/Content elements", () => {
    assert.deepEqual(parseItemRules(`<Project Sdk="Microsoft.NET.Sdk"></Project>`), []);
  });
});

describe("isImplicitItemGlobEnabled", () => {
  it("defaults to true when no switch is present", () => {
    assert.equal(isImplicitItemGlobEnabled(`<Project></Project>`, "Compile"), true);
  });

  it("is false when the per-type switch is false", () => {
    const csproj = `<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>`;

    assert.equal(isImplicitItemGlobEnabled(csproj, "Compile"), false);
    assert.equal(isImplicitItemGlobEnabled(csproj, "None"), true);
  });

  it("is false for every item type when the master switch is false", () => {
    const csproj = `<PropertyGroup><EnableDefaultItems>false</EnableDefaultItems></PropertyGroup>`;

    assert.equal(isImplicitItemGlobEnabled(csproj, "Compile"), false);
    assert.equal(isImplicitItemGlobEnabled(csproj, "None"), false);
    assert.equal(isImplicitItemGlobEnabled(csproj, "Content"), false);
  });
});

describe("resolveExcludedPaths", () => {
  const allPaths = ["Program.cs", "Generated/Model.cs", "Generated/Keep.cs"];

  it("excludes nothing when implicit glob is enabled and there are no rules", () => {
    const result = resolveExcludedPaths([], "Compile", allPaths, true);

    assert.deepEqual(result, new Set());
  });

  it("excludes files matched by a Remove glob, including nested paths", () => {
    const rules = parseItemRules(`<Compile Remove="Generated/**/*.cs" />`);

    const result = resolveExcludedPaths(rules, "Compile", allPaths, true);

    assert.deepEqual(result, new Set(["Generated/Model.cs", "Generated/Keep.cs"]));
  });

  it("treats a later explicit Include as re-including a file removed by an earlier Remove", () => {
    const rules = parseItemRules(`<ItemGroup>
      <Compile Remove="Generated/**/*.cs" />
      <Compile Include="Generated/Keep.cs" />
    </ItemGroup>`);

    const result = resolveExcludedPaths(rules, "Compile", allPaths, true);

    assert.deepEqual(result, new Set(["Generated/Model.cs"]));
  });

  it("excludes everything not explicitly included when the implicit glob is disabled", () => {
    const rules = parseItemRules(`<Compile Include="Program.cs" />`);

    const result = resolveExcludedPaths(rules, "Compile", allPaths, false);

    assert.deepEqual(result, new Set(["Generated/Model.cs", "Generated/Keep.cs"]));
  });

  it("resolves item types independently", () => {
    const rules = parseItemRules(`<Compile Remove="Generated/**/*.cs" />`);

    const compileResult = resolveExcludedPaths(rules, "Compile", allPaths, true);
    const noneResult = resolveExcludedPaths(rules, "None", allPaths, true);

    assert.deepEqual(compileResult, new Set(["Generated/Model.cs", "Generated/Keep.cs"]));
    assert.deepEqual(noneResult, new Set());
  });
});
