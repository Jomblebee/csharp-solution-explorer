import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeProjectEntry, renameProjectEntry } from "../src/solutionExplorer/slnWriter.js";
import { parseNestedProjects, parseSolutionFile } from "../src/solutionExplorer/slnParser.js";

const CSHARP_SDK_TYPE_GUID = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";
const SOLUTION_FOLDER_TYPE_GUID = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";

function sampleSolution(): string {
  return [
    "Microsoft Visual Studio Solution File, Format Version 12.00",
    `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
    "EndProject",
    `Project("${CSHARP_SDK_TYPE_GUID}") = "Library", "Library/Library.csproj", "{22222222-2222-2222-2222-222222222222}"`,
    "EndProject",
    `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"`,
    "EndProject",
    "Global",
    "\tGlobalSection(ProjectConfigurationPlatforms) = postSolution",
    "\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.ActiveCfg = Debug|Any CPU",
    "\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.Build.0 = Debug|Any CPU",
    "\t\t{22222222-2222-2222-2222-222222222222}.Debug|Any CPU.ActiveCfg = Debug|Any CPU",
    "\tEndGlobalSection",
    "\tGlobalSection(NestedProjects) = preSolution",
    "\t\t{11111111-1111-1111-1111-111111111111} = {33333333-3333-3333-3333-333333333333}",
    "\tEndGlobalSection",
    "EndGlobal",
  ].join("\n");
}

describe("removeProjectEntry", () => {
  it("removes the Project/EndProject block for the given GUID", () => {
    const result = removeProjectEntry(sampleSolution(), "{11111111-1111-1111-1111-111111111111}");

    const references = parseSolutionFile(result);
    assert.equal(references.length, 2);
    assert.deepEqual(
      references.map((r) => r.name),
      ["Library", "Solution Items"],
    );
  });

  it("removes the GUID's ProjectConfigurationPlatforms lines but keeps other GUIDs'", () => {
    const result = removeProjectEntry(sampleSolution(), "{11111111-1111-1111-1111-111111111111}");

    assert.equal(result.includes("{11111111-1111-1111-1111-111111111111}.Debug"), false);
    assert.equal(result.includes("{22222222-2222-2222-2222-222222222222}.Debug|Any CPU.ActiveCfg = Debug|Any CPU"), true);
  });

  it("removes the GUID's NestedProjects entry", () => {
    const result = removeProjectEntry(sampleSolution(), "{11111111-1111-1111-1111-111111111111}");

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.has("{11111111-1111-1111-1111-111111111111}"), false);
  });

  it("leaves the rest of the file untouched when removing a project with no extra sections", () => {
    const result = removeProjectEntry(sampleSolution(), "{22222222-2222-2222-2222-222222222222}");

    const references = parseSolutionFile(result);
    assert.deepEqual(
      references.map((r) => r.name),
      ["App", "Solution Items"],
    );
    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{11111111-1111-1111-1111-111111111111}"), "{33333333-3333-3333-3333-333333333333}");
  });

  it("preserves CRLF line endings", () => {
    const crlfSln = sampleSolution().replace(/\n/g, "\r\n");

    const result = removeProjectEntry(crlfSln, "{22222222-2222-2222-2222-222222222222}");

    assert.equal(result.includes("\r\n"), true);
    assert.equal(result.includes("Library"), false);
  });
});

describe("renameProjectEntry", () => {
  it("updates name and relativePath for the matching GUID only", () => {
    const result = renameProjectEntry(
      sampleSolution(),
      "{11111111-1111-1111-1111-111111111111}",
      "Renamed",
      "Renamed/Renamed.csproj",
    );

    const references = parseSolutionFile(result);
    const renamed = references.find((r) => r.projectGuid === "{11111111-1111-1111-1111-111111111111}");
    assert.equal(renamed?.name, "Renamed");
    assert.equal(renamed?.relativePath, "Renamed/Renamed.csproj");

    const untouched = references.find((r) => r.projectGuid === "{22222222-2222-2222-2222-222222222222}");
    assert.equal(untouched?.name, "Library");
  });

  it("leaves the type GUID and project GUID unchanged", () => {
    const result = renameProjectEntry(
      sampleSolution(),
      "{11111111-1111-1111-1111-111111111111}",
      "Renamed",
      "Renamed/Renamed.csproj",
    );

    const references = parseSolutionFile(result);
    const renamed = references.find((r) => r.projectGuid === "{11111111-1111-1111-1111-111111111111}");
    assert.equal(renamed?.typeGuid, CSHARP_SDK_TYPE_GUID);
  });

  it("does not affect ProjectConfigurationPlatforms or NestedProjects sections", () => {
    const result = renameProjectEntry(
      sampleSolution(),
      "{11111111-1111-1111-1111-111111111111}",
      "Renamed",
      "Renamed/Renamed.csproj",
    );

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{11111111-1111-1111-1111-111111111111}"), "{33333333-3333-3333-3333-333333333333}");
  });
});
