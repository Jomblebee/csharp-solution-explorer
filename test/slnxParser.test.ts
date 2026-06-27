import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSlnxFile } from "../src/solutionExplorer/slnxParser.js";
import { ProjectNode, SolutionFolderNode } from "../src/solutionExplorer/slnParser.js";

describe("parseSlnxFile", () => {
  it("returns an empty array for an empty solution", () => {
    assert.deepEqual(parseSlnxFile("<Solution></Solution>"), []);
    assert.deepEqual(parseSlnxFile("<Solution />"), []);
  });

  it("parses flat projects with no folders", () => {
    const slnx = `
<Solution>
  <Project Path="App/App.csproj" />
  <Project Path="Library/Library.csproj" />
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 2);
    assert.equal(result[0].kind, "project");
    assert.equal((result[0] as ProjectNode).relativePath, "App/App.csproj");
    assert.equal((result[0] as ProjectNode).name, "App");
    assert.equal(result[1].kind, "project");
    assert.equal((result[1] as ProjectNode).relativePath, "Library/Library.csproj");
    assert.equal((result[1] as ProjectNode).name, "Library");
  });

  it("sets guid equal to relativePath for project nodes", () => {
    const slnx = `<Solution><Project Path="src/App/App.csproj" /></Solution>`;
    const result = parseSlnxFile(slnx);

    const node = result[0] as ProjectNode;
    assert.equal(node.guid, node.relativePath);
  });

  it("parses a single folder containing projects", () => {
    const slnx = `
<Solution>
  <Folder Name="/Apps/">
    <Project Path="App/App.csproj" />
    <Project Path="Library/Library.csproj" />
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "solutionFolder");
    const folder = result[0] as SolutionFolderNode;
    assert.equal(folder.name, "Apps");
    assert.equal(folder.children.length, 2);
    assert.equal((folder.children[0] as ProjectNode).name, "App");
    assert.equal((folder.children[1] as ProjectNode).name, "Library");
  });

  it("strips leading and trailing slashes from folder names", () => {
    const slnx = `<Solution><Folder Name="/MyFolder/"><Project Path="A/A.csproj" /></Folder></Solution>`;
    const result = parseSlnxFile(slnx);

    assert.equal((result[0] as SolutionFolderNode).name, "MyFolder");
  });

  it("parses two levels of folder nesting", () => {
    const slnx = `
<Solution>
  <Folder Name="/Apps/">
    <Project Path="App/App.csproj" />
    <Folder Name="/Hosted/">
      <Project Path="Web/Web.csproj" />
    </Folder>
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 1);
    const apps = result[0] as SolutionFolderNode;
    assert.equal(apps.name, "Apps");
    assert.equal(apps.children.length, 2);

    const appProject = apps.children[0] as ProjectNode;
    assert.equal(appProject.kind, "project");
    assert.equal(appProject.name, "App");

    const hosted = apps.children[1] as SolutionFolderNode;
    assert.equal(hosted.kind, "solutionFolder");
    assert.equal(hosted.name, "Hosted");
    assert.equal(hosted.children.length, 1);
    assert.equal((hosted.children[0] as ProjectNode).name, "Web");
  });

  it("handles mixed root-level projects and folders", () => {
    const slnx = `
<Solution>
  <Project Path="Standalone/Standalone.csproj" />
  <Folder Name="/Group/">
    <Project Path="Grouped/Grouped.csproj" />
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 2);
    assert.equal(result[0].kind, "project");
    assert.equal(result[1].kind, "solutionFolder");
  });

  it("derives name correctly for multi-dot project names", () => {
    const slnx = `<Solution><Project Path="src/My.Fancy.App/My.Fancy.App.csproj" /></Solution>`;
    const result = parseSlnxFile(slnx);

    assert.equal((result[0] as ProjectNode).name, "My.Fancy.App");
  });

  it("derives name for a project with no directory segment", () => {
    const slnx = `<Solution><Project Path="App.csproj" /></Solution>`;
    const result = parseSlnxFile(slnx);

    assert.equal((result[0] as ProjectNode).name, "App");
  });

  it("normalizes Windows-style backslash paths to forward slashes", () => {
    const slnx = `<Solution><Project Path="src\\App\\App.csproj" /></Solution>`;
    const result = parseSlnxFile(slnx);

    const node = result[0] as ProjectNode;
    assert.equal(node.relativePath, "src/App/App.csproj");
    assert.equal(node.guid, "src/App/App.csproj");
  });
});
