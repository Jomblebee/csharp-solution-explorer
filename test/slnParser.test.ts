import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSolutionFile } from "../src/solutionExplorer/slnParser.js";

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
