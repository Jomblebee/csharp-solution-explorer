import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { moveSlnxFolder, moveSlnxProject } from "../src/solutionExplorer/slnxWriter.js";
import { parseSlnxFile } from "../src/solutionExplorer/slnxParser.js";
import { SolutionTreeNode } from "../src/solutionExplorer/slnParser.js";

/**
 * App at root; FolderA holds Library and a nested FolderB; FolderB holds Nested.
 *   <Solution>
 *     <Project Path="App/App.csproj" />
 *     <Folder Name="/FolderA/">
 *       <Project Path="Library/Library.csproj" />
 *       <Folder Name="/FolderB/">
 *         <Project Path="Nested/Nested.csproj" />
 *       </Folder>
 *     </Folder>
 *   </Solution>
 */
function sampleSlnx(newline = "\n"): string {
  return [
    "<Solution>",
    '  <Project Path="App/App.csproj" />',
    '  <Folder Name="/FolderA/">',
    '    <Project Path="Library/Library.csproj" />',
    '    <Folder Name="/FolderB/">',
    '      <Project Path="Nested/Nested.csproj" />',
    "    </Folder>",
    "  </Folder>",
    "</Solution>",
  ].join(newline);
}

function findFolder(nodes: SolutionTreeNode[], name: string): Extract<SolutionTreeNode, { kind: "solutionFolder" }> | undefined {
  for (const node of nodes) {
    if (node.kind === "solutionFolder") {
      if (node.name === name) {
        return node;
      }
      const inner = findFolder(node.children, name);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

function projectPaths(nodes: SolutionTreeNode[]): string[] {
  return nodes.filter((n): n is Extract<SolutionTreeNode, { kind: "project" }> => n.kind === "project").map((n) => n.relativePath);
}

describe("moveSlnxProject", () => {
  it("nests a root-level project under a folder", () => {
    const result = moveSlnxProject(sampleSlnx(), "App/App.csproj", "FolderA");
    const tree = parseSlnxFile(result);
    assert.equal(projectPaths(tree).includes("App/App.csproj"), false);
    assert.equal(projectPaths(findFolder(tree, "FolderA")!.children).includes("App/App.csproj"), true);
  });

  it("moves a nested project out to the solution root", () => {
    const result = moveSlnxProject(sampleSlnx(), "Library/Library.csproj", null);
    const tree = parseSlnxFile(result);
    assert.equal(projectPaths(tree).includes("Library/Library.csproj"), true);
    assert.equal(projectPaths(findFolder(tree, "FolderA")!.children).includes("Library/Library.csproj"), false);
  });

  it("moves a project from one folder into a deeper folder", () => {
    const result = moveSlnxProject(sampleSlnx(), "Library/Library.csproj", "FolderB");
    const tree = parseSlnxFile(result);
    assert.equal(projectPaths(findFolder(tree, "FolderB")!.children).includes("Library/Library.csproj"), true);
  });
});

describe("moveSlnxFolder", () => {
  it("moves a non-empty folder (with its subtree) to the solution root", () => {
    const result = moveSlnxFolder(sampleSlnx(), "FolderB", new Set(), null);
    const tree = parseSlnxFile(result);
    const folderB = findFolder(tree, "FolderB")!;
    // FolderB now sits at the root and still carries its Nested project.
    assert.equal(tree.some((n) => n.kind === "solutionFolder" && n.name === "FolderB"), true);
    assert.equal(projectPaths(folderB.children).includes("Nested/Nested.csproj"), true);
    // It is no longer inside FolderA.
    assert.equal(findFolder(findFolder(tree, "FolderA")!.children, "FolderB"), undefined);
  });

  it("throws when moving a folder into itself", () => {
    assert.throws(
      () => moveSlnxFolder(sampleSlnx(), "FolderA", new Set(["FolderB"]), "FolderA"),
      /itself or one of its descendants/,
    );
  });

  it("throws when moving a folder into one of its descendants", () => {
    assert.throws(
      () => moveSlnxFolder(sampleSlnx(), "FolderA", new Set(["FolderB"]), "FolderB"),
      /itself or one of its descendants/,
    );
  });

  it("preserves CRLF line endings", () => {
    const result = moveSlnxFolder(sampleSlnx("\r\n"), "FolderB", new Set(), null);
    assert.equal(result.includes("\r\n"), true);
    assert.equal(/[^\r]\n/.test(result), false);
  });
});
