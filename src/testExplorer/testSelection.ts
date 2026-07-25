// Turns a `TestRunRequest` into "what to run per project". VS Code hands over a flat list of included
// items at any depth — a whole project, a class, a single method, or a mix — while both runners work
// per project, either on everything or on a filter built from selected leaves.
//
// vscode appears here only as a type (`import type`), so the module carries no runtime dependency on
// the editor API and stays unit-testable.

import type * as vscode from "vscode";

/** Either "run the whole project" or a set of selected method-item ids. */
export type Selection = "ALL" | Set<string>;

/** Groups a run request's includes by owning project into "run all" or a selected set of method ids. */
export function groupIncludesByProject(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
): Map<vscode.TestItem, Selection> {
  const map = new Map<vscode.TestItem, Selection>();
  if (!request.include) {
    controller.items.forEach((project) => map.set(project, "ALL"));
    return map;
  }
  for (const item of request.include) {
    const project = topAncestor(item);
    if (item === project) {
      map.set(project, "ALL");
      continue;
    }
    const current = map.get(project);
    if (current === "ALL") {
      continue;
    }
    const set = current ?? new Set<string>();
    for (const id of leafIds(item)) {
      set.add(id);
    }
    map.set(project, set);
  }
  return map;
}

/** The method-item ids under an item (itself, if it is already a leaf). */
function leafIds(item: vscode.TestItem): string[] {
  const children: vscode.TestItem[] = [];
  item.children.forEach((c) => children.push(c));
  if (children.length === 0) {
    return [item.id];
  }
  return children.flatMap(leafIds);
}

function topAncestor(item: vscode.TestItem): vscode.TestItem {
  let current = item;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}
