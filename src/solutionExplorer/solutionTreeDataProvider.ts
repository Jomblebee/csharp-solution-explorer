import * as path from "node:path";
import * as vscode from "vscode";
import {
  getProjectRootDir,
  isLikelyCsproj,
  isImplicitItemGlobEnabled,
  parseItemRules,
  parsePackageReferences,
  parseProjectReferences,
  resolveExcludedPaths,
} from "./csprojReader.js";
import { listAllFilesRecursive, listDirectChildren } from "./diskScanner.js";
import { buildSolutionTree, parseNestedProjects, parseSolutionFile, SolutionTreeNode } from "./slnParser.js";
import { parseSlnxFile } from "./slnxParser.js";
import { DependenciesInfo, ExcludedPaths, ProjectInfo, SolutionInfo } from "./types.js";
import {
  DependenciesTreeItem,
  FileTreeItem,
  FolderTreeItem,
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

  /** Cache of resolved excluded-item sets, keyed by .csproj fsPath. Invalidated on any
   * filesystem change (see `scheduleRefresh`), since a changed file could affect glob
   * resolution for any project. */
  private readonly excludedPathsCache = new Map<string, ExcludedPaths>();

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
      this.excludedPathsCache.clear();
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
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
    if (element instanceof SolutionFolderTreeItem) {
      const bytes = await vscode.workspace.fs.readFile(element.info.solutionUri);
      const slnText = new TextDecoder().decode(bytes);
      const nesting = parseNestedProjects(slnText);
      return this.nodesToTreeItems(element.info.children, element.info.solutionDir, element.info.solutionUri, nesting);
    }
    if (element instanceof ProjectTreeItem) {
      return this.getProjectChildren(element.info);
    }
    if (element instanceof DependenciesTreeItem) {
      return [
        ...element.info.packages.map((info) => new PackageReferenceTreeItem(info)),
        ...element.info.projects.map((info) => new ProjectReferenceTreeItem(info)),
      ];
    }
    if (element instanceof FolderTreeItem) {
      return this.getFsChildren(element.entry.uri, element.projectRootUri, element.excludedPaths);
    }
    return [];
  }

  private async getRootItems(): Promise<SolutionExplorerTreeItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: SolutionExplorerTreeItem[] = [];

    for (const folder of folders) {
      const slnUris = [
        ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.sln"))),
        ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.slnx"))),
      ];

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
        items.push(new ProjectTreeItem(this.toProjectInfo(csprojUri, true, undefined, undefined)));
      }
    }

    return items;
  }

  private async getProjectItems(solution: SolutionInfo): Promise<SolutionExplorerTreeItem[]> {
    const bytes = await vscode.workspace.fs.readFile(solution.uri);
    const text = new TextDecoder().decode(bytes);
    const solutionDir = vscode.Uri.joinPath(solution.uri, "..");
    const nesting = parseNestedProjects(text);

    const tree = solution.uri.fsPath.toLowerCase().endsWith(".slnx")
      ? parseSlnxFile(text)
      : buildSolutionTree(parseSolutionFile(text), parseNestedProjects(text));

    return this.nodesToTreeItems(tree, solutionDir, solution.uri, nesting);
  }

  private async nodesToTreeItems(
    nodes: SolutionTreeNode[],
    solutionDir: vscode.Uri,
    solutionUri: vscode.Uri,
    nesting: Map<string, string>,
  ): Promise<SolutionExplorerTreeItem[]> {
    const items: SolutionExplorerTreeItem[] = [];
    for (const node of nodes) {
      if (node.kind === "solutionFolder") {
        items.push(
          new SolutionFolderTreeItem({
            kind: "solutionFolder",
            name: node.name,
            guid: node.guid,
            children: node.children,
            solutionDir,
            solutionUri,
          }),
        );
        continue;
      }

      if (!isLikelyCsproj(node.relativePath)) {
        continue;
      }

      const csprojUri = vscode.Uri.joinPath(solutionDir, node.relativePath);
      if (!(await fileExists(csprojUri))) {
        continue;
      }

      const parentFolderGuid = nesting.get(node.guid);
      items.push(new ProjectTreeItem(this.toProjectInfo(csprojUri, false, node.name, solutionUri, node.guid, parentFolderGuid)));
    }

    return items;
  }

  private toProjectInfo(
    csprojUri: vscode.Uri,
    isPseudoSolution: boolean,
    name: string | undefined,
    solutionUri: vscode.Uri | undefined,
    guid?: string,
    parentFolderGuid?: string,
  ): ProjectInfo {
    return {
      kind: "project",
      name: name ?? basenameWithoutExtension(csprojUri.fsPath),
      uri: csprojUri,
      rootDir: vscode.Uri.file(getProjectRootDir(csprojUri.fsPath)),
      isPseudoSolution,
      solutionUri,
      guid,
      parentFolderGuid,
    };
  }

  private async getProjectChildren(info: ProjectInfo): Promise<SolutionExplorerTreeItem[]> {
    const dependencies = await this.getDependenciesInfo(info);
    const excludedPaths = await this.getExcludedPaths(info);
    return [new DependenciesTreeItem(dependencies), ...this.getFsChildren(info.rootDir, info.rootDir, excludedPaths)];
  }

  private async getExcludedPaths(info: ProjectInfo): Promise<ExcludedPaths> {
    const cached = this.excludedPathsCache.get(info.uri.fsPath);
    if (cached) {
      return cached;
    }

    const bytes = await vscode.workspace.fs.readFile(info.uri);
    const csprojText = new TextDecoder().decode(bytes);
    const rules = parseItemRules(csprojText);
    const allFiles = listAllFilesRecursive(info.rootDir.fsPath);
    const compileFiles = allFiles.filter((p) => p.toLowerCase().endsWith(".cs"));

    const result: ExcludedPaths = {
      compile: resolveExcludedPaths(rules, "Compile", compileFiles, isImplicitItemGlobEnabled(csprojText, "Compile")),
      none: resolveExcludedPaths(rules, "None", allFiles, isImplicitItemGlobEnabled(csprojText, "None")),
      content: resolveExcludedPaths(rules, "Content", allFiles, isImplicitItemGlobEnabled(csprojText, "Content")),
    };

    this.excludedPathsCache.set(info.uri.fsPath, result);
    return result;
  }

  private async getDependenciesInfo(info: ProjectInfo): Promise<DependenciesInfo> {
    const bytes = await vscode.workspace.fs.readFile(info.uri);
    const csprojText = new TextDecoder().decode(bytes);

    const packages = parsePackageReferences(csprojText).map((ref) => ({
      kind: "packageReference" as const,
      name: ref.name,
      version: ref.version,
    }));

    const projects = parseProjectReferences(csprojText).map((ref) => {
      const uri = vscode.Uri.joinPath(info.rootDir, ref.relativePath);
      return {
        kind: "projectReference" as const,
        name: basenameWithoutExtension(uri.fsPath),
        uri,
      };
    });

    return { kind: "dependencies", packages, projects };
  }

  private getFsChildren(
    dirUri: vscode.Uri,
    projectRootUri: vscode.Uri,
    excludedPaths: ExcludedPaths,
  ): SolutionExplorerTreeItem[] {
    return listDirectChildren(dirUri.fsPath).map((scanned) => {
      const relativePath = toPosixRelative(projectRootUri.fsPath, scanned.path);
      const isExcluded =
        scanned.kind === "file" &&
        (excludedPaths.compile.has(relativePath) ||
          excludedPaths.none.has(relativePath) ||
          excludedPaths.content.has(relativePath));
      const entry = { kind: scanned.kind, name: scanned.name, uri: vscode.Uri.file(scanned.path), isExcluded };
      return entry.kind === "folder"
        ? new FolderTreeItem(entry, projectRootUri, excludedPaths)
        : new FileTreeItem(entry);
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

function toPosixRelative(fromDir: string, toPath: string): string {
  return path.relative(fromDir, toPath).split(path.sep).join("/");
}

export function basenameWithoutExtension(fsPath: string): string {
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
