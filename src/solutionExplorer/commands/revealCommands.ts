import * as path from "node:path";
import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import {
  FileTreeItem,
  FolderTreeItem,
  NestedFileTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionTreeItem,
} from "../tree/treeItems.js";
import { TerminalTarget } from "../commandUtils.js";

/** Resolves the on-disk URI a tree node points at (file/folder path, or the .csproj/.sln file). */
function resolveNodeUri(item: unknown): vscode.Uri | undefined {
  if (item instanceof FileTreeItem || item instanceof NestedFileTreeItem || item instanceof FolderTreeItem) {
    return item.entry.uri;
  }
  if (item instanceof ProjectTreeItem || item instanceof SolutionTreeItem) {
    return item.info.uri;
  }
  return undefined;
}

/** Reveals the node's file/folder in the OS file manager (Finder / Explorer / file manager). */
export function revealInOS(item: unknown): void {
  const uri = resolveNodeUri(item);
  if (uri) {
    void vscode.commands.executeCommand("revealFileInOS", uri);
  }
}

/** Reveals the active editor's file (or the passed URI) in the Solution Explorer tree. */
export async function revealInTree(
  uri: vscode.Uri | undefined,
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== "file") {
    return;
  }
  const item = await provider.findTreeItem(target);
  if (item) {
    await treeView.reveal(item, { select: true, focus: false, expand: true });
  }
}

/** Opens an integrated terminal whose working directory is the node's folder. */
export function openInTerminal(item: TerminalTarget): void {
  let cwd: vscode.Uri;
  let name: string;
  if (item instanceof SolutionTreeItem) {
    cwd = vscode.Uri.joinPath(item.info.uri, "..");
    name = path.basename(cwd.fsPath);
  } else if (item instanceof ProjectTreeItem) {
    cwd = item.info.rootDir;
    name = item.info.name;
  } else {
    cwd = item.entry.uri;
    name = item.entry.name;
  }
  vscode.window.createTerminal({ name, cwd }).show();
}
