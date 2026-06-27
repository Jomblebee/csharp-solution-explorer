import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  removeProjectEntry,
  renameProjectEntry,
  addProjectEntry,
  addProjectConfigurationPlatforms,
  addNestedProjectRelation,
  removeNestedProjectRelation,
} from "../src/solutionExplorer/slnWriter.js";
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

describe("addProjectEntry", () => {
  it("adds a new Project/EndProject block before Global", () => {
    const result = addProjectEntry(
      sampleSolution(),
      SOLUTION_FOLDER_TYPE_GUID,
      "NewFolder",
      "NewFolder",
      "{44444444-4444-4444-4444-444444444444}",
    );

    const references = parseSolutionFile(result);
    const newProject = references.find((r) => r.projectGuid === "{44444444-4444-4444-4444-444444444444}");
    assert.equal(newProject?.name, "NewFolder");
    assert.equal(newProject?.typeGuid, SOLUTION_FOLDER_TYPE_GUID);
  });

  it("adds the new entry at the end if no Global section exists", () => {
    const slnWithoutGlobal = sampleSolution().split("Global")[0].trim();
    const result = addProjectEntry(
      slnWithoutGlobal,
      SOLUTION_FOLDER_TYPE_GUID,
      "NewFolder",
      "NewFolder",
      "{44444444-4444-4444-4444-444444444444}",
    );

    const references = parseSolutionFile(result);
    assert.equal(references.length, 4);
  });
});

describe("addNestedProjectRelation", () => {
  it("adds a nesting relation to the NestedProjects section", () => {
    const result = addNestedProjectRelation(
      sampleSolution(),
      "{22222222-2222-2222-2222-222222222222}",
      "{33333333-3333-3333-3333-333333333333}",
    );

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{22222222-2222-2222-2222-222222222222}"), "{33333333-3333-3333-3333-333333333333}");
  });

  it("preserves all project entries and other sections when adding to an existing NestedProjects section", () => {
    const result = addNestedProjectRelation(
      sampleSolution(),
      "{22222222-2222-2222-2222-222222222222}",
      "{33333333-3333-3333-3333-333333333333}",
    );

    const projects = parseSolutionFile(result);
    assert.equal(projects.length, 3, "all three project entries must survive");
    assert.deepEqual(
      projects.map((p) => p.name),
      ["App", "Library", "Solution Items"],
    );
    assert.ok(result.includes("ProjectConfigurationPlatforms"), "ProjectConfigurationPlatforms section must survive");
    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{11111111-1111-1111-1111-111111111111}"), "{33333333-3333-3333-3333-333333333333}");
    assert.equal(nesting.get("{22222222-2222-2222-2222-222222222222}"), "{33333333-3333-3333-3333-333333333333}");
  });

  it("creates a NestedProjects section if it doesn't exist", () => {
    const slnWithoutNesting = [
      "Microsoft Visual Studio Solution File, Format Version 12.00",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
      "Global",
      "EndGlobal",
    ].join("\n");

    const result = addNestedProjectRelation(
      slnWithoutNesting,
      "{11111111-1111-1111-1111-111111111111}",
      "{99999999-9999-9999-9999-999999999999}",
    );

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{11111111-1111-1111-1111-111111111111}"), "{99999999-9999-9999-9999-999999999999}");
  });
});

describe("addProjectConfigurationPlatforms", () => {
  const NEW_GUID = "{44444444-4444-4444-4444-444444444444}";

  it("appends ActiveCfg and Build.0 lines per config to the existing section", () => {
    const result = addProjectConfigurationPlatforms(sampleSolution(), NEW_GUID, [
      "Debug|Any CPU",
      "Release|Any CPU",
    ]);

    assert.ok(result.includes(`\t\t${NEW_GUID}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`));
    assert.ok(result.includes(`\t\t${NEW_GUID}.Debug|Any CPU.Build.0 = Debug|Any CPU`));
    assert.ok(result.includes(`\t\t${NEW_GUID}.Release|Any CPU.ActiveCfg = Release|Any CPU`));
    assert.ok(result.includes(`\t\t${NEW_GUID}.Release|Any CPU.Build.0 = Release|Any CPU`));
    // The pre-existing entries must be untouched.
    assert.ok(result.includes("{22222222-2222-2222-2222-222222222222}.Debug|Any CPU.ActiveCfg = Debug|Any CPU"));
  });

  it("keeps the new lines inside the ProjectConfigurationPlatforms section", () => {
    const result = addProjectConfigurationPlatforms(sampleSolution(), NEW_GUID, ["Debug|Any CPU"]);

    const sectionStart = result.indexOf("GlobalSection(ProjectConfigurationPlatforms)");
    const sectionEnd = result.indexOf("EndGlobalSection", sectionStart);
    const newLine = result.indexOf(`${NEW_GUID}.Debug|Any CPU.ActiveCfg`);
    assert.ok(newLine > sectionStart && newLine < sectionEnd);
  });

  it("creates the section before EndGlobal when it doesn't exist", () => {
    const slnWithoutConfigs = [
      "Microsoft Visual Studio Solution File, Format Version 12.00",
      `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "{11111111-1111-1111-1111-111111111111}"`,
      "EndProject",
      "Global",
      "EndGlobal",
    ].join("\n");

    const result = addProjectConfigurationPlatforms(slnWithoutConfigs, NEW_GUID, ["Debug|Any CPU"]);

    assert.ok(result.includes("GlobalSection(ProjectConfigurationPlatforms) = postSolution"));
    assert.ok(result.includes(`${NEW_GUID}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`));
    const sectionStart = result.indexOf("GlobalSection(ProjectConfigurationPlatforms)");
    assert.ok(sectionStart < result.indexOf("EndGlobal"));
  });

  it("preserves CRLF line endings", () => {
    const result = addProjectConfigurationPlatforms(
      sampleSolution().split("\n").join("\r\n"),
      NEW_GUID,
      ["Debug|Any CPU"],
    );

    assert.ok(result.includes("\r\n"));
    assert.ok(result.includes(`${NEW_GUID}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`));
  });

  it("is a no-op when no configs are given", () => {
    const original = sampleSolution();
    assert.equal(addProjectConfigurationPlatforms(original, NEW_GUID, []), original);
  });
});

describe("removeNestedProjectRelation", () => {
  it("removes the nesting relation for the given child GUID", () => {
    const result = removeNestedProjectRelation(
      sampleSolution(),
      "{11111111-1111-1111-1111-111111111111}",
    );

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.has("{11111111-1111-1111-1111-111111111111}"), false);
  });

  it("does nothing if the child is not nested", () => {
    const result = removeNestedProjectRelation(
      sampleSolution(),
      "{22222222-2222-2222-2222-222222222222}",
    );

    const nesting = parseNestedProjects(result);
    assert.equal(nesting.get("{11111111-1111-1111-1111-111111111111}"), "{33333333-3333-3333-3333-333333333333}");
  });
});
