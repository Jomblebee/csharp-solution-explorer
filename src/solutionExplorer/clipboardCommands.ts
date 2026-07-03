import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import { FileTreeItem, FolderTreeItem, ProjectTreeItem, SolutionExplorerTreeItem } from "./treeItems.js";
import { copyEntriesInto, moveEntriesInto } from "./fsOps.js";
import { clearClipboard, getClipboard, setClipboard } from "./treeClipboard.js";
import { FsItem } from "./commandUtils.js";

/**
 * Collects the file/folder nodes to act on. Context-menu invocations pass the clicked item (and the
 * full selection as the second arg); keyboard shortcuts pass nothing, so fall back to the tree's
 * current selection.
 */
function collectFsItems(
  item: FsItem | undefined,
  items: FsItem[] | undefined,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): FsItem[] {
  const explicit = items && items.length > 0 ? items : item ? [item] : [];
  const source = explicit.length > 0 ? explicit : treeView.selection;
  return source.filter((i): i is FsItem => i instanceof FileTreeItem || i instanceof FolderTreeItem);
}

export function copyToClipboard(
  item: FsItem | undefined,
  items: FsItem[] | undefined,
  mode: "copy" | "cut",
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): void {
  const entries = collectFsItems(item, items, treeView);
  if (entries.length === 0) {
    return; // Nothing selectable — keep any existing clipboard contents.
  }
  setClipboard(entries.map((i) => i.entry.uri), mode);
}

/** Resolves the directory a paste should land in from the target node (folder, project, or a file's parent). */
function resolvePasteDir(item: unknown): vscode.Uri | undefined {
  if (item instanceof FolderTreeItem) {
    return item.entry.uri;
  }
  if (item instanceof ProjectTreeItem) {
    return item.info.rootDir;
  }
  if (item instanceof FileTreeItem) {
    return vscode.Uri.joinPath(item.entry.uri, "..");
  }
  return undefined;
}

export async function paste(item: SolutionExplorerTreeItem | undefined, provider: SolutionTreeDataProvider): Promise<void> {
  const clipboard = getClipboard();
  const targetDir = resolvePasteDir(item);
  if (!clipboard || !targetDir) {
    return;
  }

  // Rebuild lightweight entries from the clipboard URIs (their tree items may no longer exist).
  const entries = clipboard.uris.map((uri) => ({
    kind: fs.statSync(uri.fsPath).isDirectory() ? ("folder" as const) : ("file" as const),
    name: path.basename(uri.fsPath),
    uri,
  }));

  const { changed, errors } =
    clipboard.mode === "cut"
      ? await moveEntriesInto(
          entries.filter((e) => path.dirname(e.uri.fsPath) !== targetDir.fsPath),
          targetDir,
        )
      : await copyEntriesInto(entries, targetDir);

  if (clipboard.mode === "cut") {
    clearClipboard();
  }
  if (changed) {
    provider.refresh();
  }
  if (errors.length > 0) {
    vscode.window.showErrorMessage(`C# Solution Explorer: ${errors.join(" ")}`);
  }
}
