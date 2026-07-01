import * as path from "node:path";
import * as vscode from "vscode";
import {
  deriveImplicitFrameworks,
  getProjectRootDir,
  isLikelyCsproj,
  isImplicitItemGlobEnabled,
  parseAnalyzers,
  parseFrameworkReferences,
  parseItemRules,
  parsePackageReferences,
  parseProjectReferences,
  parseSdkAttribute,
  resolveExcludedPaths,
} from "./csprojReader.js";
import { listAllFilesRecursive, listDirectChildren, ScannedEntry } from "./diskScanner.js";
import { computeFileNesting } from "./fileNesting.js";
import { getAssetsFilePath, ParsedAssetPackage, parseProjectAssets } from "./projectAssetsReader.js";
import { compareVersions, getPackageVersions } from "../nuget/nugetApi.js";
import { buildSolutionTree, parseNestedProjects, parseSolutionFile, SolutionTreeNode } from "./slnParser.js";
import { parseSlnxFile } from "./slnxParser.js";
import {
  DependenciesInfo,
  DependencyCategory,
  ExcludedPaths,
  PackageReferenceInfo,
  ProjectInfo,
  ProjectReferenceInfo,
  SolutionInfo,
} from "./types.js";
import {
  AnalyzerTreeItem,
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  FileTreeItem,
  FolderTreeItem,
  FrameworkReferenceTreeItem,
  NestedFileTreeItem,
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

const REFRESH_DEBOUNCE_MS = 300;

/** A project's own `<ProjectReference>` entry, resolved to the referenced .csproj URI. */
interface ProjectReferenceEntry {
  name: string;
  uri: vscode.Uri;
  includePath: string;
}

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

  /** Cache of resolved dependency trees, keyed by .csproj fsPath. Invalidated on any filesystem
   * change (see `scheduleRefresh`), so edits to the .csproj or a fresh restore are picked up. */
  private readonly dependenciesCache = new Map<string, DependenciesInfo>();

  /** Cache of a project's own parsed project references, keyed by .csproj fsPath. Used both to
   * resolve the Projects category and to recursively expand transitive references. Invalidated on
   * any filesystem change (see `scheduleRefresh`). */
  private readonly projectRefsCache = new Map<string, { name: string; uri: vscode.Uri; includePath: string }[]>();

  /** Session cache of the newest stable version per package id (lowercased); `undefined` = lookup
   * failed. Deliberately NOT cleared in `scheduleRefresh`: nuget.org versions don't change on local
   * file edits, so clearing it would re-fetch on every save. */
  private readonly latestStableCache = new Map<string, string | undefined>();

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
      this.dependenciesCache.clear();
      this.projectRefsCache.clear();
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
      const info = await this.getDependenciesInfo(element.project);
      return this.getDependencyCategories(info);
    }
    if (element instanceof DependencyCategoryTreeItem) {
      return this.getCategoryChildren(element.info.category, element.info.dependencies);
    }
    if (element instanceof PackageReferenceTreeItem) {
      return (element.info.dependencies ?? []).map((info) => new PackageReferenceTreeItem(info));
    }
    if (element instanceof ProjectReferenceTreeItem) {
      const entries = await this.readProjectReferences(element.info.uri);
      const children = entries.map((entry) =>
        this.toProjectReferenceInfo(entry, element.info.uri, element.info.ancestorFsPaths, true),
      );
      return Promise.all(children.map(async (info) => new ProjectReferenceTreeItem(await this.withHasChildren(info))));
    }
    if (element instanceof FolderTreeItem) {
      return this.getFsChildren(element.entry.uri, element.projectRootUri, element.excludedPaths);
    }
    if (element instanceof NestedFileTreeItem) {
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
    const excludedPaths = await this.getExcludedPaths(info);
    // Hide the project's own .csproj from the file list; it's opened via the node's
    // "Open in Editor" context-menu command instead of appearing as a child file.
    return [
      new DependenciesTreeItem(info),
      ...this.getFsChildren(info.rootDir, info.rootDir, excludedPaths, info.uri.fsPath),
    ];
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

  /** The four dependency categories, in Visual Studio order, hiding empty ones. */
  private getDependencyCategories(info: DependenciesInfo): SolutionExplorerTreeItem[] {
    const categories: { category: DependencyCategory; count: number }[] = [
      { category: "frameworks", count: info.frameworks.length },
      { category: "analyzers", count: info.analyzers.length },
      { category: "packages", count: info.packages.length },
      { category: "projects", count: info.projects.length },
    ];
    return categories
      .filter(({ count }) => count > 0)
      .map(({ category }) => new DependencyCategoryTreeItem({ kind: "dependencyCategory", category, dependencies: info }));
  }

  private async getCategoryChildren(
    category: DependencyCategory,
    info: DependenciesInfo,
  ): Promise<SolutionExplorerTreeItem[]> {
    switch (category) {
      case "frameworks":
        return info.frameworks.map((f) => new FrameworkReferenceTreeItem(f));
      case "analyzers":
        return info.analyzers.map((a) => new AnalyzerTreeItem(a));
      case "packages":
        return (await this.enrichWithLatest(info.packages)).map((p) => new PackageReferenceTreeItem(p));
      case "projects":
        // `hasChildren` (the expand arrow) is resolved here, only when Projects is actually opened,
        // so it costs the referenced-project reads only at that point — not on every project expand.
        return Promise.all(info.projects.map(async (p) => new ProjectReferenceTreeItem(await this.withHasChildren(p))));
    }
  }

  /**
   * Flags direct packages that have a newer stable version on nuget.org by setting `latestVersion`.
   * Runs only when the `nuget.checkForUpdates` setting is on, only for direct packages with a
   * concrete (non-floating) version, and caches results for the session. Lookup failures are cached
   * as "no update" so a single broken request doesn't get retried on every expand.
   */
  private async enrichWithLatest(packages: PackageReferenceInfo[]): Promise<PackageReferenceInfo[]> {
    const enabled = vscode.workspace
      .getConfiguration("csharpSolutionExplorer")
      .get<boolean>("nuget.checkForUpdates", true);
    if (!enabled) {
      return packages;
    }
    return Promise.all(
      packages.map(async (pkg) => {
        if (pkg.isImplicit || !isConcreteVersion(pkg.version)) {
          return pkg;
        }
        const latest = await this.getLatestStable(pkg.name);
        if (latest && compareVersions(pkg.version!, latest) < 0) {
          return { ...pkg, latestVersion: latest };
        }
        return pkg;
      }),
    );
  }

  /** Returns (and session-caches) the newest stable version of a package, or `undefined` on failure. */
  private async getLatestStable(id: string): Promise<string | undefined> {
    const key = id.toLowerCase();
    if (this.latestStableCache.has(key)) {
      return this.latestStableCache.get(key);
    }
    let latest: string | undefined;
    try {
      latest = (await getPackageVersions(id))[0];
    } catch {
      latest = undefined;
    }
    this.latestStableCache.set(key, latest);
    return latest;
  }

  /** Fills in `hasChildren` for a reference by checking whether its target declares any references. */
  private async withHasChildren(ref: ProjectReferenceInfo): Promise<ProjectReferenceInfo> {
    const isCycle = ref.ancestorFsPaths.slice(0, -1).includes(ref.uri.fsPath);
    const hasChildren = !isCycle && (await this.readProjectReferences(ref.uri)).length > 0;
    return { ...ref, hasChildren };
  }

  private async getDependenciesInfo(info: ProjectInfo): Promise<DependenciesInfo> {
    const cached = this.dependenciesCache.get(info.uri.fsPath);
    if (cached) {
      return cached;
    }
    const result = await this.resolveDependenciesInfo(info);
    this.dependenciesCache.set(info.uri.fsPath, result);
    return result;
  }

  private async resolveDependenciesInfo(info: ProjectInfo): Promise<DependenciesInfo> {
    const csprojText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.uri));

    // Direct project references come straight from this .csproj text (no extra read — we seed the
    // cache from it). `hasChildren` and any transitive expansion are resolved later, on demand.
    const ownerRefs = this.parseProjectReferenceEntries(info.uri, csprojText);
    const projects = ownerRefs.map((ref) => this.toProjectReferenceInfo(ref, info.uri, [info.uri.fsPath], false));

    // Prefer the resolved restore output (project.assets.json) for full VS fidelity; fall back to
    // parsing the .csproj directly when no restore has run.
    const assets = await this.readProjectAssets(info);
    if (assets) {
      return {
        kind: "dependencies",
        projectUri: info.uri,
        frameworks: assets.frameworks.map((f) => ({ kind: "frameworkReference" as const, name: f.name, version: f.version })),
        analyzers: assets.analyzers.map((a) => ({ kind: "analyzer" as const, name: a.name, version: a.version })),
        packages: assets.packages.map((p) => toPackageReferenceInfo(p, false, info.uri)),
        projects,
      };
    }

    const frameworkNames = new Set<string>([
      ...deriveImplicitFrameworks(parseSdkAttribute(csprojText)),
      ...parseFrameworkReferences(csprojText).map((f) => f.name),
    ]);

    return {
      kind: "dependencies",
      projectUri: info.uri,
      frameworks: [...frameworkNames].map((name) => ({ kind: "frameworkReference" as const, name })),
      analyzers: parseAnalyzers(csprojText).map((a) => ({ kind: "analyzer" as const, name: a.name })),
      packages: parsePackageReferences(csprojText).map((ref) => ({
        kind: "packageReference" as const,
        name: ref.name,
        version: ref.version,
        projectUri: info.uri,
      })),
      projects,
    };
  }

  /** Resolves a .csproj's text into its own `<ProjectReference>` entries and caches them. */
  private parseProjectReferenceEntries(csprojUri: vscode.Uri, text: string): ProjectReferenceEntry[] {
    const dir = vscode.Uri.joinPath(csprojUri, "..");
    const entries = parseProjectReferences(text).map((ref) => {
      const uri = vscode.Uri.joinPath(dir, ref.relativePath);
      return { name: basenameWithoutExtension(uri.fsPath), uri, includePath: ref.relativePath };
    });
    this.projectRefsCache.set(csprojUri.fsPath, entries);
    return entries;
  }

  /** Parses (and caches) a single project's own `<ProjectReference>` entries, resolved to URIs. */
  private async readProjectReferences(csprojUri: vscode.Uri): Promise<ProjectReferenceEntry[]> {
    const cached = this.projectRefsCache.get(csprojUri.fsPath);
    if (cached) {
      return cached;
    }
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(csprojUri));
      return this.parseProjectReferenceEntries(csprojUri, text);
    } catch {
      // Referenced project file missing or unreadable — treat as having no references.
      const empty: ProjectReferenceEntry[] = [];
      this.projectRefsCache.set(csprojUri.fsPath, empty);
      return empty;
    }
  }

  /**
   * Turns a parsed reference entry into a `ProjectReferenceInfo` *without* reading the target (so it
   * does no I/O). `parentAncestors` is the chain of target fsPaths from the root project down to the
   * owner; `hasChildren` is filled in later by {@link withHasChildren} only when the node is shown.
   */
  private toProjectReferenceInfo(
    ref: ProjectReferenceEntry,
    ownerUri: vscode.Uri,
    parentAncestors: string[],
    isTransitive: boolean,
  ): ProjectReferenceInfo {
    return {
      kind: "projectReference",
      name: ref.name,
      uri: ref.uri,
      ownerUri,
      includePath: ref.includePath,
      isTransitive,
      ancestorFsPaths: [...parentAncestors, ref.uri.fsPath],
    };
  }

  private async readProjectAssets(info: ProjectInfo) {
    const assetsUri = vscode.Uri.file(getAssetsFilePath(info.rootDir.fsPath));
    try {
      const bytes = await vscode.workspace.fs.readFile(assetsUri);
      return parseProjectAssets(new TextDecoder().decode(bytes));
    } catch {
      // No restore output yet — caller falls back to .csproj parsing.
      return undefined;
    }
  }

  private getFsChildren(
    dirUri: vscode.Uri,
    projectRootUri: vscode.Uri,
    excludedPaths: ExcludedPaths,
    hiddenFsPath?: string,
  ): SolutionExplorerTreeItem[] {
    const scanned = listDirectChildren(dirUri.fsPath).filter((e) => e.path !== hiddenFsPath);

    // Collapse related files under a parent (appsettings.*.json, .xaml.cs, .razor companions, …),
    // like Visual Studio. Disabled → every file stays flat.
    const nestingEnabled = vscode.workspace
      .getConfiguration("csharpSolutionExplorer")
      .get<boolean>("fileNesting.enabled", true);
    const { childrenByParent, nestedChildNames } = nestingEnabled
      ? computeFileNesting(scanned)
      : { childrenByParent: new Map<string, ScannedEntry[]>(), nestedChildNames: new Set<string>() };

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
      if (s.kind === "file" && nestedChildNames.has(s.name.toLowerCase())) {
        continue; // hidden — appears as a child of its parent file's node
      }
      const entry = makeEntry(s);
      if (entry.kind === "folder") {
        items.push(new FolderTreeItem(entry, projectRootUri, excludedPaths));
      } else {
        const children = childrenByParent.get(s.name.toLowerCase());
        if (children && children.length > 0) {
          items.push(new NestedFileTreeItem(entry, children.map(makeEntry)));
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

/** Maps an assets.json package (with its transitive subtree) to a tree `PackageReferenceInfo`. */
function toPackageReferenceInfo(
  pkg: ParsedAssetPackage,
  isImplicit: boolean,
  projectUri?: vscode.Uri,
): PackageReferenceInfo {
  return {
    kind: "packageReference",
    name: pkg.name,
    version: pkg.version,
    projectUri,
    isImplicit,
    // Transitive children are informational only — no owning project, so they can't be removed/updated.
    dependencies: pkg.dependencies.map((child) => toPackageReferenceInfo(child, true)),
  };
}

/** A version is "concrete" (comparable to a latest version) when it's a fixed number, not a float like `9.*`. */
function isConcreteVersion(version: string | undefined): version is string {
  return !!version && !version.includes("*") && !version.includes(",") && /\d/.test(version);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
