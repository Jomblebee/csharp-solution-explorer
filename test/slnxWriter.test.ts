import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addSlnxFolderEntry,
  removeSlnxProjectEntry,
  renameSlnxProjectEntry,
} from "../src/solutionExplorer/slnxWriter.js";
import { parseSlnxFile } from "../src/solutionExplorer/slnxParser.js";

function fixture(): string {
  return [
    "<Solution>",
    '  <Folder Name="/Apps/">',
    '    <Project Path="App/App.csproj" />',
    '    <Project Path="Library/Library.csproj" />',
    "  </Folder>",
    '  <Project Path="Standalone/Standalone.csproj" />',
    "</Solution>",
  ].join("\n");
}

function fixtureWithCrlf(): string {
  return fixture().split("\n").join("\r\n");
}

describe("removeSlnxProjectEntry", () => {
  it("removes a nested project by path", () => {
    const result = removeSlnxProjectEntry(fixture(), "App/App.csproj");

    assert.ok(!result.includes("App/App.csproj"));
    assert.ok(result.includes("Library/Library.csproj"));
    assert.ok(result.includes("Standalone/Standalone.csproj"));
  });

  it("removes a root-level project by path", () => {
    const result = removeSlnxProjectEntry(fixture(), "Standalone/Standalone.csproj");

    assert.ok(!result.includes("Standalone/Standalone.csproj"));
    assert.ok(result.includes("App/App.csproj"));
  });

  it("is a no-op for an unknown path", () => {
    const original = fixture();
    const result = removeSlnxProjectEntry(original, "NonExistent/Foo.csproj");

    assert.equal(result, original);
  });

  it("preserves CRLF line endings", () => {
    const result = removeSlnxProjectEntry(fixtureWithCrlf(), "App/App.csproj");

    assert.ok(result.includes("\r\n"));
    assert.ok(!result.includes("App/App.csproj"));
  });

  it("matches paths case-insensitively", () => {
    const result = removeSlnxProjectEntry(fixture(), "app/APP.CSPROJ");

    assert.ok(!result.includes("App/App.csproj"));
  });
});

describe("renameSlnxProjectEntry", () => {
  it("updates the Path attribute of the matching project", () => {
    const result = renameSlnxProjectEntry(fixture(), "App/App.csproj", "RenamedApp/RenamedApp.csproj");

    assert.ok(result.includes('Path="RenamedApp/RenamedApp.csproj"'));
    assert.ok(!result.includes('Path="App/App.csproj"'));
  });

  it("leaves other project entries untouched", () => {
    const result = renameSlnxProjectEntry(fixture(), "App/App.csproj", "RenamedApp/RenamedApp.csproj");

    assert.ok(result.includes("Library/Library.csproj"));
    assert.ok(result.includes("Standalone/Standalone.csproj"));
  });

  it("is a no-op for an unknown path", () => {
    const original = fixture();
    const result = renameSlnxProjectEntry(original, "NonExistent/Foo.csproj", "New/New.csproj");

    assert.equal(result, original);
  });

  it("preserves CRLF line endings", () => {
    const result = renameSlnxProjectEntry(fixtureWithCrlf(), "App/App.csproj", "RenamedApp/RenamedApp.csproj");

    assert.ok(result.includes("\r\n"));
    assert.ok(result.includes("RenamedApp/RenamedApp.csproj"));
  });

  it("matches paths case-insensitively", () => {
    const result = renameSlnxProjectEntry(fixture(), "APP/APP.CSPROJ", "RenamedApp/RenamedApp.csproj");

    assert.ok(result.includes('Path="RenamedApp/RenamedApp.csproj"'));
  });

  it("preserves indentation of the updated line", () => {
    const result = renameSlnxProjectEntry(fixture(), "App/App.csproj", "New/New.csproj");
    const updatedLine = result.split("\n").find((l) => l.includes("New/New.csproj"))!;

    assert.ok(updatedLine.startsWith("    "));
  });
});

describe("addSlnxFolderEntry", () => {
  it("adds a root-level folder before </Solution> that the parser recognizes", () => {
    const result = addSlnxFolderEntry(fixture(), "NewFolder");
    const tree = parseSlnxFile(result);

    assert.ok(tree.some((node) => node.kind === "solutionFolder" && node.name === "NewFolder"));
  });

  it("writes an empty folder as a non-self-closing open/close pair", () => {
    const result = addSlnxFolderEntry(fixture(), "NewFolder");

    assert.ok(result.includes('<Folder Name="/NewFolder/"></Folder>'));
  });

  it("nests the folder inside the named parent folder", () => {
    const result = addSlnxFolderEntry(fixture(), "Sub", "Apps");
    const apps = parseSlnxFile(result).find((n) => n.kind === "solutionFolder" && n.name === "Apps");

    assert.ok(apps && apps.kind === "solutionFolder");
    assert.ok(apps.children.some((c) => c.kind === "solutionFolder" && c.name === "Sub"));
  });

  it("preserves CRLF line endings", () => {
    const result = addSlnxFolderEntry(fixtureWithCrlf(), "NewFolder");

    assert.ok(result.includes("\r\n"));
    assert.ok(result.includes('<Folder Name="/NewFolder/">'));
  });

  it("indents a root-level folder one level deep", () => {
    const result = addSlnxFolderEntry(fixture(), "NewFolder");
    const line = result.split("\n").find((l) => l.includes("/NewFolder/"))!;

    assert.ok(line.startsWith("  <Folder"));
  });

  it("is a no-op when the parent folder is not found", () => {
    const original = fixture();
    const result = addSlnxFolderEntry(original, "Sub", "DoesNotExist");

    assert.equal(result, original);
  });

  it("nests into a freshly created inline-empty folder by expanding it", () => {
    // Simulates the UI flow: create a root folder, then create a child inside it.
    const afterFirst = addSlnxFolderEntry(fixture(), "Created");
    const afterSecond = addSlnxFolderEntry(afterFirst, "Child", "Created");
    const created = parseSlnxFile(afterSecond).find((n) => n.kind === "solutionFolder" && n.name === "Created");

    assert.ok(created && created.kind === "solutionFolder");
    assert.ok(created.children.some((c) => c.kind === "solutionFolder" && c.name === "Child"));
  });

  it("counts inline child folders correctly when locating the parent's close", () => {
    const withInlineChild = [
      "<Solution>",
      '  <Folder Name="/Apps/">',
      '    <Folder Name="/Inline/"></Folder>',
      '    <Project Path="App/App.csproj" />',
      "  </Folder>",
      "</Solution>",
    ].join("\n");
    const result = addSlnxFolderEntry(withInlineChild, "Added", "Apps");
    const apps = parseSlnxFile(result).find((n) => n.kind === "solutionFolder" && n.name === "Apps");

    assert.ok(apps && apps.kind === "solutionFolder");
    assert.ok(apps.children.some((c) => c.kind === "solutionFolder" && c.name === "Added"));
    assert.ok(apps.children.some((c) => c.kind === "solutionFolder" && c.name === "Inline"));
  });
});
