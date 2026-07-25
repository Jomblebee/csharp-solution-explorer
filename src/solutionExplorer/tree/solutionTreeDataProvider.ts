import * as vscode from "vscode";
import { DependencyTreeResolver } from "./dependencyTree.js";
import { ProjectFileTreeBuilder } from "./projectFileTree.js";
import { getProjectItems, getRootItems, nodesToTreeItems } from "./solutionNodes.js";
import { findTreeItem } from "./treeReveal.js";
import { parseNestedProjects } from "../parsers/slnParser.js";
import { ProjectInfo } from "../types.js";
import {
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  FileTreeItem,
  FolderTreeItem,
  NestedFileTreeItem,
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

const REFRESH_DEBOUNCE_MS = 300;

export class SolutionTreeDataProvider implements vscode.TreeDataProvider<SolutionExplorerTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SolutionExplorerTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly watcher: vscode.FileSystemWatcher;
  private readonly workspaceFoldersListener: vscode.Disposable;
  private refreshTimeout: NodeJS.Timeout | undefined;

  private readonly dependencies = new DependencyTreeResolver();
  private readonly files = new ProjectFileTreeBuilder();

  /** Parent pointer per tree item, recorded as children are produced, so `getParent` (and therefore
   * `TreeView.reveal`) can walk from a leaf back up to the root. */
  private readonly parentMap = new WeakMap<SolutionExplorerTreeItem, SolutionExplorerTreeItem>();

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
    this.refreshTimeout = setTimeout(() => {
      this.files.clearCaches();
      this.dependencies.clearCaches();
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SolutionExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: SolutionExplorerTreeItem): SolutionExplorerTreeItem | undefined {
    return this.parentMap.get(element);
  }

  async getChildren(element?: SolutionExplorerTreeItem): Promise<SolutionExplorerTreeItem[]> {
    const children = await this.computeChildren(element);
    if (element) {
      for (const child of children) {
        this.parentMap.set(child, element);
      }
    }
    return children;
  }

  private async computeChildren(element?: SolutionExplorerTreeItem): Promise<SolutionExplorerTreeItem[]> {
    if (!element) {
      return getRootItems();
    }
    if (element instanceof SolutionTreeItem) {
      return getProjectItems(element.info);
    }
    if (element instanceof SolutionFolderTreeItem) {
      const nesting = element.info.isVirtual
        ? new Map<string, string>()
        : parseNestedProjects(new TextDecoder().decode(await vscode.workspace.fs.readFile(element.info.solutionUri)));
      return nodesToTreeItems(
        element.info.children,
        element.info.solutionDir,
        element.info.solutionUri,
        nesting,
        element.info.stableId,
      );
    }
    if (element instanceof ProjectTreeItem) {
      return this.getProjectChildren(element.info);
    }
    if (element instanceof DependenciesTreeItem) {
      const info = await this.dependencies.getDependenciesInfo(element.project);
      return this.dependencies.getDependencyCategories(info);
    }
    if (element instanceof DependencyCategoryTreeItem) {
      return this.dependencies.getCategoryChildren(element.info.category, element.info.dependencies);
    }
    if (element instanceof PackageReferenceTreeItem) {
      return (element.info.dependencies ?? []).map((info) => new PackageReferenceTreeItem(info));
    }
    if (element instanceof ProjectReferenceTreeItem) {
      return this.dependencies.expandProjectReference(element.info);
    }
    if (element instanceof FolderTreeItem) {
      return this.files.getFsChildren(element.entry.uri, element.projectRootUri, element.excludedPaths);
    }
    if (element instanceof NestedFileTreeItem) {
      return element.companions.map((c) => new FileTreeItem(c));
    }
    return [];
  }

  /**
   * Resolves the tree item for a file/folder URI by walking the live tree from the roots down, so the
   * returned instance (and its recorded parents) can be handed to `TreeView.reveal`. Returns
   * `undefined` when the path lies outside every project. Populates `parentMap` along the way.
   */
  async findTreeItem(uri: vscode.Uri): Promise<SolutionExplorerTreeItem | undefined> {
    return findTreeItem((element) => this.getChildren(element), uri);
  }

  private async getProjectChildren(info: ProjectInfo): Promise<SolutionExplorerTreeItem[]> {
    const excludedPaths = await this.files.getExcludedPaths(info);
    // Hide the project's own .csproj from the file list; it's opened via the node's
    // "Open in Editor" context-menu command instead of appearing as a child file.
    return [
      new DependenciesTreeItem(info),
      ...this.files.getFsChildren(info.rootDir, info.rootDir, excludedPaths, info.uri.fsPath),
    ];
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
