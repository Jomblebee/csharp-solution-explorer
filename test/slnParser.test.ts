import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSolutionTree, parseNestedProjects, parseSolutionFile } from "../src/solutionExplorer/slnParser.js";

const SOLUTION_FOLDER_TYPE_GUID = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";
const CSHARP_SDK_TYPE_GUID = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";

describe("parseSolutionFile", () => {
  it("normalizes Windows-style backslash paths to forward slashes", () => {
    const sln = [
      'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App", "App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"',
      "EndProject",
    ].join("\n");

    const result = parseSolutionFile(sln);

    assert.equal(result.length, 1);
    assert.equal(result[0].relativePath, "App/App.csproj");
  });

  it("extracts multiple project entries with correct fields", () => {
    const sln = [
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "Library", "Library/Library.csproj", "{22222222-2222-2222-2222-222222222222}"`,
      "EndProject",
    ].join("\n");

    const result = parseSolutionFile(sln);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      typeGuid: CSHARP_SDK_TYPE_GUID,
      name: "App",
      relativePath: "App/App.csproj",
      projectGuid: "{11111111-1111-1111-1111-111111111111}",
    });
    assert.equal(result[1].name, "Library");
  });

  it("includes solution-folder entries unfiltered (filtering happens in the provider)", () => {
    const sln = [
      `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"`,
      "EndProject",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
    ].join("\n");

    const result = parseSolutionFile(sln);

    assert.equal(result.length, 2);
    assert.equal(result[0].typeGuid, SOLUTION_FOLDER_TYPE_GUID);
  });

  it("returns an empty array for input with no Project(...) lines", () => {
    const result = parseSolutionFile("Microsoft Visual Studio Solution File, Format Version 12.00\n");

    assert.deepEqual(result, []);
  });
});

describe("parseNestedProjects", () => {
  it("returns an empty map when there is no NestedProjects section", () => {
    const result = parseNestedProjects("Microsoft Visual Studio Solution File, Format Version 12.00\n");

    assert.equal(result.size, 0);
  });

  it("parses child/parent guid pairs from the NestedProjects section", () => {
    const sln = [
      "Global",
      "\tGlobalSection(NestedProjects) = preSolution",
      "\t\t{11111111-1111-1111-1111-111111111111} = {33333333-3333-3333-3333-333333333333}",
      "\t\t{22222222-2222-2222-2222-222222222222} = {33333333-3333-3333-3333-333333333333}",
      "\tEndGlobalSection",
      "EndGlobal",
    ].join("\n");

    const result = parseNestedProjects(sln);

    assert.equal(result.size, 2);
    assert.equal(result.get("{11111111-1111-1111-1111-111111111111}"), "{33333333-3333-3333-3333-333333333333}");
    assert.equal(result.get("{22222222-2222-2222-2222-222222222222}"), "{33333333-3333-3333-3333-333333333333}");
  });
});

describe("buildSolutionTree", () => {
  it("treats every entry as a root when there is no nesting", () => {
    const sln = [
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
    ].join("\n");

    const tree = buildSolutionTree(parseSolutionFile(sln), new Map());

    assert.equal(tree.length, 1);
    assert.equal(tree[0].kind, "project");
  });

  it("nests a project under its solution folder", () => {
    const sln = [
      `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"`,
      "EndProject",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
    ].join("\n");
    const nesting = new Map([
      ["{11111111-1111-1111-1111-111111111111}", "{33333333-3333-3333-3333-333333333333}"],
    ]);

    const tree = buildSolutionTree(parseSolutionFile(sln), nesting);

    assert.equal(tree.length, 1);
    assert.equal(tree[0].kind, "solutionFolder");
    assert.equal(tree[0].name, "Solution Items");
    const folder = tree[0] as Extract<(typeof tree)[number], { kind: "solutionFolder" }>;
    assert.equal(folder.children.length, 1);
    assert.equal(folder.children[0].kind, "project");
    assert.equal(folder.children[0].name, "App");
  });

  it("nests a solution folder under another solution folder", () => {
    const sln = [
      `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "Outer", "Outer", "{33333333-3333-3333-3333-333333333333}"`,
      "EndProject",
      `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "Inner", "Inner", "{44444444-4444-4444-4444-444444444444}"`,
      "EndProject",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
    ].join("\n");
    const nesting = new Map([
      ["{44444444-4444-4444-4444-444444444444}", "{33333333-3333-3333-3333-333333333333}"],
      ["{11111111-1111-1111-1111-111111111111}", "{44444444-4444-4444-4444-444444444444}"],
    ]);

    const tree = buildSolutionTree(parseSolutionFile(sln), nesting);

    assert.equal(tree.length, 1);
    const outer = tree[0] as Extract<(typeof tree)[number], { kind: "solutionFolder" }>;
    assert.equal(outer.name, "Outer");
    assert.equal(outer.children.length, 1);
    const inner = outer.children[0] as Extract<(typeof tree)[number], { kind: "solutionFolder" }>;
    assert.equal(inner.name, "Inner");
    assert.equal(inner.children.length, 1);
    assert.equal(inner.children[0].name, "App");
  });
});
