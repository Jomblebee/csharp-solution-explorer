import * as path from "node:path";
import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import { SolutionTreeNode } from "../parsers/slnParser.js";
import { parseSolutionFile } from "../parsers/slnParser.js";
import { removeProjectEntry, renameProjectEntry } from "../parsers/slnWriter.js";
import {
  removeSlnxFolderEntry,
  removeSlnxProjectEntry,
  renameSlnxFolderEntry,
  renameSlnxProjectEntry,
} from "../parsers/slnxWriter.js";
import { FileTreeItem, ProjectTreeItem, SolutionFolderTreeItem } from "../tree/treeItems.js";
import { ProjectInfo, SolutionFolderInfo } from "../types.js";
import { errorMessage, ExistingItemTarget, isExistingItemTarget, toPosixRelative } from "../commandUtils.js";

function getEntryUri(item: ExistingItemTarget): vscode.Uri {
  if (item instanceof ProjectTreeItem) {
    return item.info.uri;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.solutionUri;
  }
  return item.entry.uri;
}

function getDisplayName(item: ExistingItemTarget): string {
  if (item instanceof ProjectTreeItem) {
    return item.info.name;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.name;
  }
  return item.entry.name;
}

export async function rename(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isExistingItemTarget(item)) {
    return;
  }

  const currentName = getDisplayName(item);
  const newName = await vscode.window.showInputBox({ prompt: "New name", value: currentName });
  if (!newName || newName === currentName) {
    return;
  }

  if (item instanceof ProjectTreeItem) {
    await renameProject(item.info, newName);
  } else if (item instanceof SolutionFolderTreeItem) {
    await renameSolutionFolder(item.info, newName);
  } else {
    const oldUri = getEntryUri(item);
    const finalName =
      item instanceof FileTreeItem && !newName.includes(".")
        ? `${newName}${path.extname(currentName)}`
        : newName;
    const newUri = vscode.Uri.joinPath(oldUri, "..", finalName);
    await vscode.workspace.fs.rename(oldUri, newUri);
  }

  provider.refresh();
}

async function renameSolutionFolder(info: SolutionFolderInfo, newName: string): Promise<void> {
  if (!info.guid) {
    throw new Error("Solution folder GUID is missing");
  }

  const slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));
  const isSlnx = info.solutionUri.fsPath.toLowerCase().endsWith(".slnx");
  const newSlnText = isSlnx
    ? renameSlnxFolderEntry(slnText, info.guid, newName)
    : renameProjectEntry(slnText, info.guid, newName, newName);
  await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
}

async function deleteSolutionFolder(info: SolutionFolderInfo): Promise<void> {
  if (!info.guid) {
    throw new Error("Solution folder GUID is missing");
  }

  let slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));

  if (info.solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
    const newSlnText = removeSlnxFolderEntry(slnText, info.guid);
    await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    return;
  }

  function collectDescendantGuids(node: SolutionTreeNode, guids: Set<string>): void {
    if (node.kind === "solutionFolder") {
      guids.add(node.guid);
      for (const child of node.children) {
        collectDescendantGuids(child, guids);
      }
    } else {
      guids.add(node.guid);
    }
  }

  const descendantGuids = new Set<string>();
  for (const child of info.children) {
    collectDescendantGuids(child, descendantGuids);
  }

  for (const guid of descendantGuids) {
    slnText = removeProjectEntry(slnText, guid);
  }
  slnText = removeProjectEntry(slnText, info.guid);

  await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(slnText));
}

async function renameProject(info: ProjectInfo, newName: string): Promise<void> {
  let solutionGuid: string | undefined;
  let originalRelativePath: string | undefined;
  let solutionDir: vscode.Uri | undefined;
  let slnText: string | undefined;
  const isSlnx = info.solutionUri?.fsPath.toLowerCase().endsWith(".slnx") ?? false;

  if (info.solutionUri) {
    solutionDir = vscode.Uri.joinPath(info.solutionUri, "..");
    originalRelativePath = toPosixRelative(solutionDir.fsPath, info.uri.fsPath);
    slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));
    if (!isSlnx) {
      solutionGuid = parseSolutionFile(slnText).find(
        (ref) => ref.relativePath.toLowerCase() === originalRelativePath!.toLowerCase(),
      )?.projectGuid;
    }
  }

  const oldCsprojUri = info.uri;
  let csprojUri = vscode.Uri.joinPath(info.uri, "..", `${newName}.csproj`);
  const renameRootDir = path.basename(info.rootDir.fsPath) === info.name;
  const oldRootDir = info.rootDir;
  let newRootDir: vscode.Uri | undefined;

  await vscode.workspace.fs.rename(oldCsprojUri, csprojUri);

  try {
    if (renameRootDir) {
      newRootDir = vscode.Uri.joinPath(info.rootDir, "..", newName);
      await vscode.workspace.fs.rename(oldRootDir, newRootDir);
      csprojUri = vscode.Uri.joinPath(newRootDir, `${newName}.csproj`);
    }

    if (info.solutionUri && solutionDir && slnText && originalRelativePath) {
      const newRelativePath = toPosixRelative(solutionDir.fsPath, csprojUri.fsPath);
      const newSlnText = isSlnx
        ? renameSlnxProjectEntry(slnText, originalRelativePath, newRelativePath)
        : solutionGuid
          ? renameProjectEntry(slnText, solutionGuid, newName, newRelativePath)
          : slnText;
      await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    }
  } catch (err) {
    await rollbackRenameProject(newRootDir, oldRootDir, csprojUri, oldCsprojUri, errorMessage(err));
    throw err;
  }
}

async function rollbackRenameProject(
  newRootDir: vscode.Uri | undefined,
  oldRootDir: vscode.Uri,
  csprojUri: vscode.Uri,
  oldCsprojUri: vscode.Uri,
  originalErrorMessage: string,
): Promise<void> {
  try {
    if (newRootDir) {
      await vscode.workspace.fs.rename(newRootDir, oldRootDir);
      const csprojUnderOldRoot = vscode.Uri.joinPath(oldRootDir, path.basename(csprojUri.fsPath));
      await vscode.workspace.fs.rename(csprojUnderOldRoot, oldCsprojUri);
    } else {
      await vscode.workspace.fs.rename(csprojUri, oldCsprojUri);
    }
  } catch (rollbackErr) {
    throw new Error(
      `Rename failed (${originalErrorMessage}) and automatic rollback also failed ` +
        `(${errorMessage(rollbackErr)}) — the project is left in an inconsistent state and must be fixed manually.`,
    );
  }
}

export async function deleteItem(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isExistingItemTarget(item)) {
    return;
  }

  const itemName = getDisplayName(item);
  const message =
    item instanceof SolutionFolderTreeItem
      ? `Delete '${itemName}'? Projects it contains will also be removed from the solution. This action cannot be undone.`
      : `Delete '${itemName}'? This action cannot be undone.`;

  const confirmation = await vscode.window.showWarningMessage(message, { modal: true }, "Delete");
  if (confirmation !== "Delete") {
    return;
  }

  if (item instanceof ProjectTreeItem) {
    await deleteProject(item.info);
  } else if (item instanceof SolutionFolderTreeItem) {
    await deleteSolutionFolder(item.info);
  } else {
    await vscode.workspace.fs.delete(getEntryUri(item), { recursive: true, useTrash: true });
  }

  provider.refresh();
}

async function deleteProject(info: ProjectInfo): Promise<void> {
  await vscode.workspace.fs.delete(info.rootDir, { recursive: true, useTrash: true });

  if (info.solutionUri) {
    const solutionDir = vscode.Uri.joinPath(info.solutionUri, "..");
    const relativePath = toPosixRelative(solutionDir.fsPath, info.uri.fsPath);
    const slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));

    try {
      let newSlnText: string;
      if (info.solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
        newSlnText = removeSlnxProjectEntry(slnText, relativePath);
      } else {
        const guid = parseSolutionFile(slnText).find(
          (ref) => ref.relativePath.toLowerCase() === relativePath.toLowerCase(),
        )?.projectGuid;
        if (!guid) {return;}
        newSlnText = removeProjectEntry(slnText, guid);
      }
      await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    } catch (err) {
      throw new Error(
        `Project files were deleted, but updating '${path.basename(info.solutionUri.fsPath)}' failed: ` +
          `${errorMessage(err)}. Remove the stale entry manually.`,
      );
    }
  }
}
