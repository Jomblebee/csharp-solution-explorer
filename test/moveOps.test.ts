import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { moveProjectToFolder, moveSolutionFolderInto } from "../src/solutionExplorer/moveOps.js";
import { buildSolutionTree, parseNestedProjects, parseSolutionFile, SolutionTreeNode } from "../src/solutionExplorer/slnParser.js";

const CSHARP_SDK_TYPE_GUID = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";
const SOLUTION_FOLDER_TYPE_GUID = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";

const APP = "{11111111-1111-1111-1111-111111111111}";
const LIB = "{22222222-2222-2222-2222-222222222222}";
const FOLDER_A = "{33333333-3333-3333-3333-333333333333}";
const FOLDER_B = "{44444444-4444-4444-4444-444444444444}";

/** App is nested under FolderA; FolderB is nested under FolderA. */
function sampleSolution(): string {
  return [
    "Microsoft Visual Studio Solution File, Format Version 12.00",
    `Project("${CSHARP_SDK_TYPE_GUID}") = "App", "App/App.csproj", "${APP}"`,
    "EndProject",
    `Project("${CSHARP_SDK_TYPE_GUID}") = "Library", "Library/Library.csproj", "${LIB}"`,
    "EndProject",
    `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "FolderA", "FolderA", "${FOLDER_A}"`,
    "EndProject",
    `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "FolderB", "FolderB", "${FOLDER_B}"`,
    "EndProject",
    "Global",
    "\tGlobalSection(NestedProjects) = preSolution",
    `\t\t${APP} = ${FOLDER_A}`,
    `\t\t${FOLDER_B} = ${FOLDER_A}`,
    "\tEndGlobalSection",
    "EndGlobal",
  ].join("\n");
}

function childrenOf(slnText: string, guid: string): SolutionTreeNode[] {
  const tree = buildSolutionTree(parseSolutionFile(slnText), parseNestedProjects(slnText));
  const found = findFolder(tree, guid);
  return found ? found.children : [];
}

function findFolder(nodes: SolutionTreeNode[], guid: string): Extract<SolutionTreeNode, { kind: "solutionFolder" }> | undefined {
  for (const node of nodes) {
    if (node.kind === "solutionFolder") {
      if (node.guid === guid) {
        return node;
      }
      const inner = findFolder(node.children, guid);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

describe("moveProjectToFolder", () => {
  it("re-parents a project from one folder to another", () => {
    const result = moveProjectToFolder(sampleSolution(), APP, FOLDER_B);
    assert.equal(parseNestedProjects(result).get(APP), FOLDER_B);
  });

  it("moves a project to the root when target is null (removes its nesting)", () => {
    const result = moveProjectToFolder(sampleSolution(), APP, null);
    assert.equal(parseNestedProjects(result).has(APP), false);
  });

  it("nests a previously root-level project", () => {
    const result = moveProjectToFolder(sampleSolution(), LIB, FOLDER_A);
    assert.equal(parseNestedProjects(result).get(LIB), FOLDER_A);
  });
});

describe("moveSolutionFolderInto", () => {
  it("moves a folder to the root when target is null", () => {
    const result = moveSolutionFolderInto(sampleSolution(), FOLDER_B, childrenOf(sampleSolution(), FOLDER_B), null);
    assert.equal(parseNestedProjects(result).has(FOLDER_B), false);
  });

  it("throws when moving a folder into itself", () => {
    assert.throws(
      () => moveSolutionFolderInto(sampleSolution(), FOLDER_A, childrenOf(sampleSolution(), FOLDER_A), FOLDER_A),
      /itself or one of its descendants/,
    );
  });

  it("throws when moving a folder into one of its descendants", () => {
    // FolderB is a descendant of FolderA, so moving FolderA into FolderB must fail.
    assert.throws(
      () => moveSolutionFolderInto(sampleSolution(), FOLDER_A, childrenOf(sampleSolution(), FOLDER_A), FOLDER_B),
      /itself or one of its descendants/,
    );
  });

  it("keeps the nesting when re-pointing a leaf folder at an allowed target", () => {
    const result = moveSolutionFolderInto(sampleSolution(), FOLDER_B, childrenOf(sampleSolution(), FOLDER_B), FOLDER_A);
    assert.equal(parseNestedProjects(result).get(FOLDER_B), FOLDER_A);
  });
});
