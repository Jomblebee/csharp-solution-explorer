import * as path from "node:path";
import * as vscode from "vscode";
import { collectDescendantFolderGuids, moveProjectToFolder, moveSolutionFolderInto } from "./moveOps.js";
import { moveSlnxFolder, moveSlnxProject } from "./slnxWriter.js";
import { SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import {
  FileTreeItem,
  FolderTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

/** Internal MIME type for drags originating from this view (lowercased tree view id). */
const MIME_TYPE = "application/vnd.code.tree.csharpsolutionexplorer.view";

type StructureItem = ProjectTreeItem | SolutionFolderTreeItem;
type FsItem = FileTreeItem | FolderTreeItem;

function isMovable(item: SolutionExplorerTreeItem): boolean {
  return (
    item instanceof ProjectTreeItem ||
    item instanceof SolutionFolderTreeItem ||
    item instanceof FileTreeItem ||
    item instanceof FolderTreeItem
  );
}

export class SolutionTreeDragAndDropController
  implements vscode.TreeDragAndDropController<SolutionExplorerTreeItem>
{
  readonly dragMimeTypes = [MIME_TYPE];
  readonly dropMimeTypes = [MIME_TYPE];

  constructor(private readonly provider: SolutionTreeDataProvider) {}

  handleDrag(
    source: readonly SolutionExplorerTreeItem[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const movable = source.filter(isMovable);
    if (movable.length > 0) {
      dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(movable));
    }
  }

  async handleDrop(
    target: SolutionExplorerTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const transferItem = dataTransfer.get(MIME_TYPE);
    if (!transferItem) {
      return;
    }
    const dragged = transferItem.value as SolutionExplorerTreeItem[];

    try {
      const structureItems = dragged.filter(
        (d): d is StructureItem => d instanceof ProjectTreeItem || d instanceof SolutionFolderTreeItem,
      );
      const fsItems = dragged.filter(
        (d): d is FsItem => d instanceof FileTreeItem || d instanceof FolderTreeItem,
      );

      if (structureItems.length > 0) {
        await this.handleStructureDrop(structureItems, target);
      }
      if (fsItems.length > 0) {
        await this.handleFsDrop(fsItems, target);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`C# Solution Explorer: ${errorMessage(err)}`);
    }
  }

  /** Re-parents projects / solution folders within the .sln (virtual nesting, no disk changes). */
  private async handleStructureDrop(
    items: StructureItem[],
    target: SolutionExplorerTreeItem | undefined,
  ): Promise<void> {
    let solutionUri: vscode.Uri;
    let targetFolderGuid: string | null;
    let targetName: string;
    if (target instanceof SolutionFolderTreeItem) {
      solutionUri = target.info.solutionUri;
      targetFolderGuid = target.info.guid;
      targetName = `into '${target.info.name}'`;
    } else if (target instanceof SolutionTreeItem) {
      solutionUri = target.info.uri;
      targetFolderGuid = null;
      targetName = "to the solution root";
    } else {
      return; // Projects / solution folders can only be dropped onto a solution folder or the solution root.
    }

    const isSlnx = solutionUri.fsPath.toLowerCase().endsWith(".slnx");

    // Items that actually have somewhere to go (same solution, not a self-drop).
    const movable = items.filter((item) => {
      const itemSolutionUri = item.info.solutionUri;
      if (!itemSolutionUri || itemSolutionUri.fsPath !== solutionUri.fsPath) {
        return false; // Cannot move items across different solutions.
      }
      if (item instanceof ProjectTreeItem) {
        // For .sln we can detect a no-op via the known parent; for .slnx the parent is unknown.
        return !!item.info.guid && (isSlnx || (item.info.parentFolderGuid ?? null) !== targetFolderGuid);
      }
      return item.info.guid !== targetFolderGuid; // Solution folder dropped onto itself.
    });
    if (movable.length === 0) {
      return;
    }

    if (!(await this.confirmMove(moveMessage(movable.length, movable[0].info.name, targetName)))) {
      return;
    }

    let slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));
    let changed = false;

    for (const item of movable) {
      if (item instanceof ProjectTreeItem) {
        slnText = isSlnx
          ? moveSlnxProject(slnText, item.info.guid!, targetFolderGuid)
          : moveProjectToFolder(slnText, item.info.guid!, targetFolderGuid);
      } else if (isSlnx) {
        const descendants = new Set<string>();
        for (const child of item.info.children) {
          collectDescendantFolderGuids(child, descendants);
        }
        slnText = moveSlnxFolder(slnText, item.info.guid, descendants, targetFolderGuid);
      } else {
        slnText = moveSolutionFolderInto(slnText, item.info.guid, item.info.children, targetFolderGuid);
      }
      changed = true;
    }

    if (changed) {
      await vscode.workspace.fs.writeFile(solutionUri, new TextEncoder().encode(slnText));
      this.provider.refresh();
    }
  }

  /** Shows a modal confirmation before a move, unless disabled via the `confirmMove` setting. */
  private async confirmMove(message: string): Promise<boolean> {
    const enabled = vscode.workspace
      .getConfiguration("csharpSolutionExplorer")
      .get<boolean>("confirmMove", true);
    if (!enabled) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Move");
    return choice === "Move";
  }

  /** Moves files / folders on disk into the target folder (works within and across projects). */
  private async handleFsDrop(
    items: FsItem[],
    target: SolutionExplorerTreeItem | undefined,
  ): Promise<void> {
    let targetDir: vscode.Uri;
    if (target instanceof FolderTreeItem) {
      targetDir = target.entry.uri;
    } else if (target instanceof ProjectTreeItem) {
      targetDir = target.info.rootDir;
    } else if (target instanceof FileTreeItem) {
      targetDir = vscode.Uri.joinPath(target.entry.uri, "..");
    } else {
      return; // Files/folders can only be dropped onto a folder, project, or file (virtual nodes are invalid targets).
    }

    const movable = items.filter((item) => path.dirname(item.entry.uri.fsPath) !== targetDir.fsPath);
    if (movable.length === 0) {
      return; // Everything is already in the target directory.
    }
    if (!(await this.confirmMove(moveMessage(movable.length, movable[0].entry.name, `into '${path.basename(targetDir.fsPath)}'`)))) {
      return;
    }

    const errors: string[] = [];
    let moved = false;

    for (const item of movable) {
      const sourceUri = item.entry.uri;

      if (item instanceof FolderTreeItem && isInsideOrEqual(targetDir.fsPath, sourceUri.fsPath)) {
        errors.push(`'${item.entry.name}' cannot be moved into itself.`);
        continue;
      }

      const destUri = vscode.Uri.joinPath(targetDir, item.entry.name);
      try {
        await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
        moved = true;
      } catch {
        errors.push(`'${item.entry.name}' could not be moved (a file or folder with that name may already exist).`);
      }
    }

    if (moved) {
      this.provider.refresh();
    }
    if (errors.length > 0) {
      vscode.window.showErrorMessage(`C# Solution Explorer: ${errors.join(" ")}`);
    }
  }
}

/** Builds the confirmation prompt, e.g. `Move 'App' into 'Tests'?` or `Move 3 items to the solution root?`. */
function moveMessage(count: number, firstName: string, target: string): string {
  const what = count === 1 ? `'${firstName}'` : `${count} items`;
  return `Move ${what} ${target}?`;
}

/** True when `candidate` is `base` itself or a path nested below it. */
function isInsideOrEqual(candidate: string, base: string): boolean {
  if (candidate === base) {
    return true;
  }
  return candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
