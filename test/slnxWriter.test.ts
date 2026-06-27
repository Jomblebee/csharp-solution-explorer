import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeSlnxProjectEntry, renameSlnxProjectEntry } from "../src/solutionExplorer/slnxWriter.js";

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
