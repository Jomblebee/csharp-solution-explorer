import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseTargetFrameworks } from "./csprojReader.js";
import {
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  FileTreeItem,
  FolderTreeItem,
  ProjectTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

/** Nodes a "New …" command can target (a container that owns a directory). */
export type NewItemTarget = FolderTreeItem | ProjectTreeItem | SolutionFolderTreeItem;
/** Nodes that can be renamed or deleted. */
export type ExistingItemTarget = FolderTreeItem | FileTreeItem | ProjectTreeItem | SolutionFolderTreeItem;
/** File-system nodes (the only things the clipboard operates on). */
export type FsItem = FileTreeItem | FolderTreeItem;
/** Nodes that resolve to a directory an integrated terminal can open in. */
export type TerminalTarget = SolutionTreeItem | ProjectTreeItem | FolderTreeItem;

export async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    vscode.window.showErrorMessage(`C# Solution Explorer: ${errorMessage(err)}`);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isNewItemTarget(item: unknown): item is NewItemTarget {
  return item instanceof FolderTreeItem || item instanceof ProjectTreeItem || item instanceof SolutionFolderTreeItem;
}

export function isExistingItemTarget(item: unknown): item is ExistingItemTarget {
  return (
    item instanceof FolderTreeItem ||
    item instanceof FileTreeItem ||
    item instanceof ProjectTreeItem ||
    item instanceof SolutionFolderTreeItem
  );
}

export function validateNewName(value: string, dirPath: string, suffix = ""): string | undefined {
  if (!value.trim()) {
    return "Name must not be empty";
  }
  if (/[\\/]/.test(value)) {
    return "Name must not contain path separators";
  }
  if (fs.existsSync(path.join(dirPath, `${value}${suffix}`))) {
    return "A file or folder with that name already exists";
  }
  return undefined;
}

export function toPosixRelative(fromDirPath: string, toPath: string): string {
  return path.relative(fromDirPath, toPath).split(path.sep).join("/");
}

export function generateSlnGuid(): string {
  return `{${crypto.randomUUID().toUpperCase()}}`;
}

/** Returned when the user dismissed the target-framework prompt, as distinct from "not needed". */
export const CANCELLED = Symbol("cancelled");

/**
 * The target framework to build/run/debug with. `dotnet` refuses to choose for a multi-targeted
 * project, so ask; single-target projects return `undefined` and get no `--framework` flag at all.
 * Shared by the Run command and the debugger so the two cannot disagree.
 */
export async function resolveRunFramework(
  projectUri: vscode.Uri,
  projectName: string,
): Promise<string | undefined | typeof CANCELLED> {
  let frameworks: string[];
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri));
    // Unresolved MSBuild variables ($(Var)) come through unfiltered; only concrete monikers are usable.
    frameworks = parseTargetFrameworks(text).filter((tfm) => /^net(\d+)\.\d+$/i.test(tfm.trim()));
  } catch {
    return undefined;
  }
  if (frameworks.length < 2) {
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(frameworks, {
    title: `Target framework — ${projectName}`,
    placeHolder: "Select the framework to use",
  });
  return picked ?? CANCELLED;
}

/** The .csproj that should receive a new reference, derived from the right-clicked node. */
export function resolveOwningProjectUri(item: unknown): vscode.Uri | undefined {
  if (item instanceof ProjectTreeItem) {
    return item.info.uri;
  }
  if (item instanceof DependenciesTreeItem) {
    return item.project.uri;
  }
  if (item instanceof DependencyCategoryTreeItem) {
    return item.info.dependencies.projectUri;
  }
  return undefined;
}
