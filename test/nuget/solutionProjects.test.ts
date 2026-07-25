import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenProjectNodes, parseSolutionProjects } from "../../src/nuget/solutionProjects.js";
import { SolutionTreeNode } from "../../src/solutionExplorer/slnParser.js";

describe("flattenProjectNodes", () => {
  it("collects projects across nested solution folders", () => {
    const nodes: SolutionTreeNode[] = [
      { kind: "project", guid: "{1}", name: "Root", relativePath: "Root/Root.csproj" },
      {
        kind: "solutionFolder",
        guid: "{2}",
        name: "Apps",
        children: [
          { kind: "project", guid: "{3}", name: "App", relativePath: "App/App.csproj" },
          {
            kind: "solutionFolder",
            guid: "{4}",
            name: "Inner",
            children: [{ kind: "project", guid: "{5}", name: "Lib", relativePath: "Lib/Lib.csproj" }],
          },
        ],
      },
    ];
    assert.deepEqual(
      flattenProjectNodes(nodes).map((p) => p.name),
      ["Root", "App", "Lib"],
    );
  });

  it("keeps same-named projects from different folders apart", () => {
    // The manager keys projects by path, not name — two `Tests` projects must both survive.
    const nodes: SolutionTreeNode[] = [
      {
        kind: "solutionFolder",
        guid: "{1}",
        name: "Api",
        children: [{ kind: "project", guid: "{2}", name: "Tests", relativePath: "Api/Tests/Tests.csproj" }],
      },
      {
        kind: "solutionFolder",
        guid: "{3}",
        name: "Web",
        children: [{ kind: "project", guid: "{4}", name: "Tests", relativePath: "Web/Tests/Tests.csproj" }],
      },
    ];
    assert.deepEqual(
      flattenProjectNodes(nodes).map((p) => p.relativePath),
      ["Api/Tests/Tests.csproj", "Web/Tests/Tests.csproj"],
    );
  });

  it("returns nothing for empty input and for folders with no projects", () => {
    assert.deepEqual(flattenProjectNodes([]), []);
    assert.deepEqual(
      flattenProjectNodes([
        { kind: "solutionFolder", guid: "{1}", name: "Empty", children: [] },
        {
          kind: "solutionFolder",
          guid: "{2}",
          name: "Outer",
          children: [{ kind: "solutionFolder", guid: "{3}", name: "Inner", children: [] }],
        },
      ]),
      [],
    );
  });
});

describe("parseSolutionProjects", () => {
  it("parses .slnx projects and drops non-csproj entries", () => {
    const slnx = `<Solution>
  <Folder Name="/Apps/">
    <Project Path="App/App.csproj" />
    <Project Path="docs/readme.md" />
  </Folder>
  <Project Path="Library/Library.csproj" />
</Solution>`;
    assert.deepEqual(parseSolutionProjects(slnx, true), [
      { name: "App", relativePath: "App/App.csproj" },
      { name: "Library", relativePath: "Library/Library.csproj" },
    ]);
  });

  it("parses classic .sln projects, normalizing backslash paths and skipping solution folders", () => {
    const sln = `
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App", "App\\App.csproj", "{AAAAAAAA-0000-0000-0000-000000000001}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "SolutionItems", "SolutionItems", "{BBBBBBBB-0000-0000-0000-000000000002}"
EndProject
`;
    assert.deepEqual(parseSolutionProjects(sln, false), [{ name: "App", relativePath: "App/App.csproj" }]);
  });
});
