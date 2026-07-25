import * as vscode from "vscode";
import { isInsideOrEqual, pickOwningProjectPath } from "../fsPathUtils.js";
import {
  FolderTreeItem,
  NestedFileTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

/**
 * Produces the children of a tree node. The provider passes its own `getChildren` in, so walking the
 * tree here also records the parent pointers that `TreeView.reveal` needs.
 */
export type ChildrenFn = (element?: SolutionExplorerTreeItem) => Promise<SolutionExplorerTreeItem[]>;

/**
 * Resolves the tree item for a file/folder URI by walking the live tree from the roots down, so the
 * returned instance (and its recorded parents) can be handed to `TreeView.reveal`. Returns
 * `undefined` when the path lies outside every project.
 */
export async function findTreeItem(
  getChildren: ChildrenFn,
  uri: vscode.Uri,
): Promise<SolutionExplorerTreeItem | undefined> {
  const target = uri.fsPath;

  const projects: ProjectTreeItem[] = [];
  for (const root of await getChildren()) {
    if (root instanceof ProjectTreeItem) {
      if (root.info.uri.fsPath === target) {
        return root;
      }
      if (isInsideOrEqual(target, root.info.rootDir.fsPath)) {
        projects.push(root);
      }
    } else if (root instanceof SolutionTreeItem) {
      if (root.info.uri.fsPath === target) {
        return root;
      }
      await collectContainingProjects(getChildren, root, target, projects);
    }
  }

  const ownerRoot = pickOwningProjectPath(projects.map((p) => p.info.rootDir.fsPath), target);
  if (!ownerRoot) {
    return undefined;
  }
  const owner = projects.find((p) => p.info.rootDir.fsPath === ownerRoot)!;
  if (owner.info.uri.fsPath === target) {
    return owner;
  }
  return findInProject(getChildren, owner, target);
}

/** Recurses structural nodes (solution / solution folders) collecting projects that contain `target`. */
async function collectContainingProjects(
  getChildren: ChildrenFn,
  structural: SolutionTreeItem | SolutionFolderTreeItem,
  target: string,
  out: ProjectTreeItem[],
): Promise<void> {
  for (const child of await getChildren(structural)) {
    if (child instanceof ProjectTreeItem) {
      if (child.info.uri.fsPath === target || isInsideOrEqual(target, child.info.rootDir.fsPath)) {
        out.push(child);
      }
    } else if (child instanceof SolutionFolderTreeItem) {
      await collectContainingProjects(getChildren, child, target, out);
    }
  }
}

/** Descends a project's file tree (through folders and file-nesting) to the item matching `target`. */
async function findInProject(
  getChildren: ChildrenFn,
  project: ProjectTreeItem,
  target: string,
): Promise<SolutionExplorerTreeItem | undefined> {
  let level = await getChildren(project);
  while (true) {
    const exact = level.find((c) => c.resourceUri?.fsPath === target);
    if (exact) {
      return exact;
    }

    const nested = level.find(
      (c): c is NestedFileTreeItem =>
        c instanceof NestedFileTreeItem && c.companions.some((k) => k.uri.fsPath === target),
    );
    if (nested) {
      const companion = (await getChildren(nested)).find((c) => c.resourceUri?.fsPath === target);
      return companion ?? nested;
    }

    const folder = level.find(
      (c): c is FolderTreeItem => c instanceof FolderTreeItem && isInsideOrEqual(target, c.entry.uri.fsPath),
    );
    if (!folder) {
      return undefined;
    }
    level = await getChildren(folder);
  }
}
