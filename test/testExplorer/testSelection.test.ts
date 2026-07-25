import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { groupIncludesByProject, type Selection } from "../../src/testExplorer/testSelection.js";

// `testSelection` imports vscode as a type only, so the tree it walks can be plain objects: it reads
// `id`, `parent` and `children.forEach` and nothing else. Same for the controller (`items.forEach`)
// and the request (`include`). The casts below are the whole vscode surface of this file.

interface FakeItem {
  id: string;
  parent?: FakeItem;
  children: { forEach(callback: (child: FakeItem) => void): void };
}

/** Builds an item and wires the children's `parent` back to it. */
function item(id: string, children: FakeItem[] = []): FakeItem {
  const node: FakeItem = {
    id,
    children: { forEach: (callback) => children.forEach((child) => callback(child)) },
  };
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

function group(roots: FakeItem[], include?: FakeItem[]): Map<vscode.TestItem, Selection> {
  const controller = { items: { forEach: (callback: (root: FakeItem) => void) => roots.forEach(callback) } };
  const request = { include };
  return groupIncludesByProject(
    controller as unknown as vscode.TestController,
    request as unknown as vscode.TestRunRequest,
  );
}

function selectionOf(map: Map<vscode.TestItem, Selection>, project: FakeItem): Selection | undefined {
  return map.get(project as unknown as vscode.TestItem);
}

/** A project with one class holding two methods, matching what `groupByClass` builds. */
function projectFixture(name: string): { project: FakeItem; klass: FakeItem; methods: [FakeItem, FakeItem] } {
  const methods: [FakeItem, FakeItem] = [item(`${name}::C.A`), item(`${name}::C.B`)];
  const klass = item(`${name}::C`, methods);
  const project = item(name, [klass]);
  return { project, klass, methods };
}

describe("groupIncludesByProject", () => {
  it("runs every project in full when the request includes nothing", () => {
    const a = projectFixture("A.csproj");
    const b = projectFixture("B.csproj");

    const map = group([a.project, b.project]);

    assert.equal(map.size, 2);
    assert.equal(selectionOf(map, a.project), "ALL");
    assert.equal(selectionOf(map, b.project), "ALL");
  });

  it("runs a project in full when the project node itself is included", () => {
    const a = projectFixture("A.csproj");

    const map = group([a.project], [a.project]);

    assert.equal(map.size, 1);
    assert.equal(selectionOf(map, a.project), "ALL");
  });

  it("collects the method ids under an included class node", () => {
    const a = projectFixture("A.csproj");

    const map = group([a.project], [a.klass]);

    assert.deepEqual(selectionOf(map, a.project), new Set(["A.csproj::C.A", "A.csproj::C.B"]));
  });

  it("uses a leaf's own id when the leaf is included", () => {
    const a = projectFixture("A.csproj");

    const map = group([a.project], [a.methods[1]]);

    assert.deepEqual(selectionOf(map, a.project), new Set(["A.csproj::C.B"]));
  });

  it("merges several leaves of the same project into one set", () => {
    const a = projectFixture("A.csproj");

    const map = group([a.project], [a.methods[0], a.methods[1]]);

    assert.equal(map.size, 1);
    assert.deepEqual(selectionOf(map, a.project), new Set(["A.csproj::C.A", "A.csproj::C.B"]));
  });

  it("lets the project node win over a leaf of the same project, in either order", () => {
    const a = projectFixture("A.csproj");

    assert.equal(selectionOf(group([a.project], [a.project, a.methods[0]]), a.project), "ALL");
    assert.equal(selectionOf(group([a.project], [a.methods[0], a.project]), a.project), "ALL");
  });

  it("keeps the projects apart", () => {
    const a = projectFixture("A.csproj");
    const b = projectFixture("B.csproj");

    const map = group([a.project, b.project], [a.methods[0], b.project]);

    assert.deepEqual(selectionOf(map, a.project), new Set(["A.csproj::C.A"]));
    assert.equal(selectionOf(map, b.project), "ALL");
  });

  it("returns nothing for an empty include list", () => {
    const a = projectFixture("A.csproj");

    assert.equal(group([a.project], []).size, 0);
  });

  it("walks deeper nesting down to the leaves", () => {
    const leaf = item("A.csproj::Outer.Inner.M");
    const inner = item("A.csproj::Outer.Inner", [leaf]);
    const outer = item("A.csproj::Outer", [inner]);
    const project = item("A.csproj", [outer]);

    const map = group([project], [outer]);

    assert.deepEqual(selectionOf(map, project), new Set(["A.csproj::Outer.Inner.M"]));
  });

  it("climbs several levels to find the owning project of a deep leaf", () => {
    const leaf = item("A.csproj::Outer.Inner.M");
    const inner = item("A.csproj::Outer.Inner", [leaf]);
    const outer = item("A.csproj::Outer", [inner]);
    const project = item("A.csproj", [outer]);

    const map = group([project], [leaf]);

    assert.equal(map.size, 1);
    assert.deepEqual(selectionOf(map, project), new Set(["A.csproj::Outer.Inner.M"]));
  });
});
