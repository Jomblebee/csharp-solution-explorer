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
import { listAllFilesRecursive, listDirectChildren, ScannedEntry } from "./diskScanner.js";
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
  RazorFileTreeItem,
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
      const nesting = element.info.isVirtual
        ? new Map<string, string>()
        : parseNestedProjects(new TextDecoder().decode(await vscode.workspace.fs.readFile(element.info.solutionUri)));
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
    if (element instanceof RazorFileTreeItem) {
      return element.companions.map((c) => new FileTreeItem(c));
    }
    return [];
  }

  private async getRootItems(): Promise<SolutionExplorerTreeItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: SolutionExplorerTreeItem[] = [];

    for (const folder of folders) {
      const exclude = new vscode.RelativePattern(folder, "**/{node_modules,bin,obj,.git,.vs}/**");
      const slnUris = [
        ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.sln"), exclude)),
        ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.slnx"), exclude)),
      ].sort((a, b) => a.fsPath.localeCompare(b.fsPath));

      if (slnUris.length > 0) {
        for (const slnUri of slnUris) {
          const relativeDir = toPosixRelative(folder.uri.fsPath, path.dirname(slnUri.fsPath));
          const info: SolutionInfo = {
            kind: "solution",
            name: basenameWithoutExtension(slnUri.fsPath),
            uri: slnUri,
            relativeDir: relativeDir || undefined,
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
            isVirtual: node.isVirtual,
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
    const scanned = listDirectChildren(dirUri.fsPath);

    const razorLowerNames = scanned
      .filter((e) => e.kind === "file" && e.name.toLowerCase().endsWith(".razor"))
      .map((e) => e.name.toLowerCase())
      // Longest first so "Foo.razor" wins over a shorter prefix when both could match.
      .sort((a, b) => b.length - a.length);

    // Map each ".razor" file (lowercase name) to its companion files, e.g.
    // "Foo.razor" → ["Foo.razor.cs", "Foo.razor.css", "Foo.razor.js"], like Visual Studio.
    const razorToCompanions = new Map<string, ScannedEntry[]>();
    for (const e of scanned) {
      if (e.kind !== "file") {
        continue;
      }
      const lower = e.name.toLowerCase();
      const parentLower = razorLowerNames.find((razor) => lower.startsWith(razor + "."));
      if (parentLower) {
        const list = razorToCompanions.get(parentLower) ?? [];
        list.push(e);
        razorToCompanions.set(parentLower, list);
      }
    }
    const nestedCompanionLower = new Set(
      [...razorToCompanions.values()].flat().map((e) => e.name.toLowerCase()),
    );

    const makeEntry = (s: ScannedEntry) => {
      const relativePath = toPosixRelative(projectRootUri.fsPath, s.path);
      const isExcluded =
        s.kind === "file" &&
        (excludedPaths.compile.has(relativePath) ||
          excludedPaths.none.has(relativePath) ||
          excludedPaths.content.has(relativePath));
      return { kind: s.kind, name: s.name, uri: vscode.Uri.file(s.path), isExcluded };
    };

    const items: SolutionExplorerTreeItem[] = [];
    for (const s of scanned) {
      if (s.kind === "file" && nestedCompanionLower.has(s.name.toLowerCase())) {
        continue; // hidden — appears as child of its .razor node
      }
      const entry = makeEntry(s);
      if (entry.kind === "folder") {
        items.push(new FolderTreeItem(entry, projectRootUri, excludedPaths));
      } else {
        const companions = razorToCompanions.get(s.name.toLowerCase());
        if (companions && companions.length > 0) {
          const companionEntries = companions
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(makeEntry);
          items.push(new RazorFileTreeItem(entry, companionEntries));
        } else {
          items.push(new FileTreeItem(entry));
        }
      }
    }
    return items;
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
