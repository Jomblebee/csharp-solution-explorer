import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nestPathBasedFolders, parseSlnxFile } from "../src/solutionExplorer/slnxParser.js";
import { ProjectNode, SolutionFolderNode, SolutionTreeNode } from "../src/solutionExplorer/slnParser.js";

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

  it("groups path-like folder names into a virtual nested hierarchy", () => {
    const slnx = `
<Solution>
  <Folder Name="/src/base/Alpha/">
    <Project Path="src/base/Alpha/Alpha.csproj" />
  </Folder>
  <Folder Name="/src/base/Beta/">
    <Project Path="src/base/Beta/Beta.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Tests.csproj" />
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 2, "should have virtual 'src' and real 'tests' at root");

    const src = result[0] as SolutionFolderNode;
    assert.equal(src.kind, "solutionFolder");
    assert.equal(src.name, "src");
    assert.equal(src.isVirtual, true);

    const base = src.children[0] as SolutionFolderNode;
    assert.equal(base.kind, "solutionFolder");
    assert.equal(base.name, "base");
    assert.equal(base.isVirtual, true);
    assert.equal(base.children.length, 2);
    assert.equal((base.children[0] as SolutionFolderNode).name, "Alpha");
    assert.equal((base.children[0] as SolutionFolderNode).isVirtual, undefined);
    assert.equal((base.children[1] as SolutionFolderNode).name, "Beta");

    const tests = result[1] as SolutionFolderNode;
    assert.equal(tests.name, "tests");
    assert.equal(tests.isVirtual, undefined);
  });

  it("preserves project children of path-based folders after grouping", () => {
    const slnx = `
<Solution>
  <Folder Name="/src/App/">
    <Project Path="src/App/App.csproj" />
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    const src = result[0] as SolutionFolderNode;
    const app = src.children[0] as SolutionFolderNode;
    assert.equal(app.name, "App");
    assert.equal(app.children.length, 1);
    assert.equal((app.children[0] as ProjectNode).relativePath, "src/App/App.csproj");
  });

  it("maintains insertion order between path groups and non-path nodes", () => {
    const slnx = `
<Solution>
  <Folder Name="/a/X/">
    <Project Path="a/X/X.csproj" />
  </Folder>
  <Folder Name="/standalone/">
    <Project Path="standalone/S.csproj" />
  </Folder>
  <Folder Name="/a/Y/">
    <Project Path="a/Y/Y.csproj" />
  </Folder>
</Solution>`;

    const result = parseSlnxFile(slnx);

    assert.equal(result.length, 2);
    assert.equal((result[0] as SolutionFolderNode).name, "a");
    assert.equal((result[1] as SolutionFolderNode).name, "standalone");

    const a = result[0] as SolutionFolderNode;
    assert.equal(a.children.length, 2);
    assert.equal((a.children[0] as SolutionFolderNode).name, "X");
    assert.equal((a.children[1] as SolutionFolderNode).name, "Y");
  });
});

describe("nestPathBasedFolders", () => {
  function folder(name: string, children: SolutionTreeNode[] = []): SolutionFolderNode {
    return { kind: "solutionFolder", guid: name, name, children };
  }
  function project(name: string): ProjectNode {
    return { kind: "project", guid: name, name, relativePath: `${name}/${name}.csproj` };
  }

  it("is a no-op when no folder names contain slashes", () => {
    const nodes: SolutionTreeNode[] = [folder("src"), folder("tests"), project("App")];
    const result = nestPathBasedFolders(nodes);

    assert.equal(result.length, 3);
    assert.equal(result[0], nodes[0]);
    assert.equal(result[1], nodes[1]);
    assert.equal(result[2], nodes[2]);
  });

  it("groups two siblings sharing a common prefix under one virtual node", () => {
    const nodes: SolutionTreeNode[] = [folder("src/A"), folder("src/B")];
    const result = nestPathBasedFolders(nodes);

    assert.equal(result.length, 1);
    const src = result[0] as SolutionFolderNode;
    assert.equal(src.name, "src");
    assert.equal(src.isVirtual, true);
    assert.equal(src.children.length, 2);
    assert.equal((src.children[0] as SolutionFolderNode).name, "A");
    assert.equal((src.children[1] as SolutionFolderNode).name, "B");
  });

  it("nests three path levels deep", () => {
    const nodes: SolutionTreeNode[] = [folder("a/b/c/d")];
    const result = nestPathBasedFolders(nodes);

    const a = result[0] as SolutionFolderNode;
    assert.equal(a.name, "a");
    assert.equal(a.isVirtual, true);
    const b = a.children[0] as SolutionFolderNode;
    assert.equal(b.name, "b");
    assert.equal(b.isVirtual, true);
    const c = b.children[0] as SolutionFolderNode;
    assert.equal(c.name, "c");
    assert.equal(c.isVirtual, true);
    const d = c.children[0] as SolutionFolderNode;
    assert.equal(d.name, "d");
    assert.equal(d.isVirtual, undefined);
  });

  it("passes through project nodes unchanged", () => {
    const p = project("App");
    const nodes: SolutionTreeNode[] = [folder("src/A"), p];
    const result = nestPathBasedFolders(nodes);

    assert.equal(result[1], p);
  });
});
