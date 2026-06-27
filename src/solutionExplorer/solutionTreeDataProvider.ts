import * as vscode from "vscode";
import { getProjectRootDir, isLikelyCsproj } from "./csprojReader.js";
import { listDirectChildren } from "./diskScanner.js";
import { parseSolutionFile, SOLUTION_FOLDER_TYPE_GUID } from "./slnParser.js";
import { ProjectInfo, SolutionInfo } from "./types.js";
import { FileTreeItem, FolderTreeItem, ProjectTreeItem, SolutionExplorerTreeItem, SolutionTreeItem } from "./treeItems.js";

const REFRESH_DEBOUNCE_MS = 300;

export class SolutionTreeDataProvider implements vscode.TreeDataProvider<SolutionExplorerTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SolutionExplorerTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly watcher: vscode.FileSystemWatcher;
  private readonly workspaceFoldersListener: vscode.Disposable;
  private refreshTimeout: NodeJS.Timeout | undefined;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());

    this.workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SolutionExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SolutionExplorerTreeItem): Promise<SolutionExplorerTreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof SolutionTreeItem) {
      return this.getProjectItems(element.info);
    }
    if (element instanceof ProjectTreeItem) {
      return this.getFsChildren(element.info.rootDir);
    }
    if (element instanceof FolderTreeItem) {
      return this.getFsChildren(element.entry.uri);
    }
    return [];
  }

  private async getRootItems(): Promise<SolutionExplorerTreeItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: SolutionExplorerTreeItem[] = [];

    for (const folder of folders) {
      const slnUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.sln"));

      if (slnUris.length > 0) {
        for (const slnUri of slnUris) {
          const info: SolutionInfo = {
            kind: "solution",
            name: basenameWithoutExtension(slnUri.fsPath),
            uri: slnUri,
          };
          items.push(new SolutionTreeItem(info));
        }
        continue;
      }

      const csprojUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.csproj"));
      for (const csprojUri of csprojUris) {
        items.push(new ProjectTreeItem(this.toProjectInfo(csprojUri, true)));
      }
    }

    return items;
  }

  private async getProjectItems(solution: SolutionInfo): Promise<SolutionExplorerTreeItem[]> {
    const bytes = await vscode.workspace.fs.readFile(solution.uri);
    const slnText = new TextDecoder().decode(bytes);
    const references = parseSolutionFile(slnText);
    const solutionDir = vscode.Uri.joinPath(solution.uri, "..");

    const items: SolutionExplorerTreeItem[] = [];
    for (const reference of references) {
      if (reference.typeGuid === SOLUTION_FOLDER_TYPE_GUID) {
        continue;
      }
      if (!isLikelyCsproj(reference.relativePath)) {
        continue;
      }

      const csprojUri = vscode.Uri.joinPath(solutionDir, reference.relativePath);
      if (!(await fileExists(csprojUri))) {
        continue;
      }

      items.push(new ProjectTreeItem(this.toProjectInfo(csprojUri, false, reference.name)));
    }

    return items;
  }

  private toProjectInfo(csprojUri: vscode.Uri, isPseudoSolution: boolean, name?: string): ProjectInfo {
    return {
      kind: "project",
      name: name ?? basenameWithoutExtension(csprojUri.fsPath),
      uri: csprojUri,
      rootDir: vscode.Uri.file(getProjectRootDir(csprojUri.fsPath)),
      isPseudoSolution,
    };
  }

  private getFsChildren(dirUri: vscode.Uri): SolutionExplorerTreeItem[] {
    return listDirectChildren(dirUri.fsPath).map((scanned) => {
      const entry = { kind: scanned.kind, name: scanned.name, uri: vscode.Uri.file(scanned.path) };
      return entry.kind === "folder" ? new FolderTreeItem(entry) : new FileTreeItem(entry);
    });
  }

  dispose(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.watcher.dispose();
    this.workspaceFoldersListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function basenameWithoutExtension(fsPath: string): string {
  const base = fsPath.split(/[/\\]/).pop() ?? fsPath;
  return base.replace(/\.[^.]+$/, "");
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
