import * as vscode from "vscode";
import {
  deriveImplicitFrameworks,
  parseAnalyzers,
  parseFrameworkReferences,
  parsePackageReferences,
  parseProjectReferences,
  parseSdkAttribute,
} from "../parsers/csprojReader.js";
import { basenameWithoutExtension } from "../fsPathUtils.js";
import { getAssetsFilePath, ParsedAssetPackage, parseProjectAssets } from "../parsers/projectAssetsReader.js";
import { getPackageVersions } from "../../nuget/nugetApi.js";
import { compareVersions } from "../../nuget/versionCompare.js";
import {
  DependenciesInfo,
  DependencyCategory,
  PackageReferenceInfo,
  ProjectInfo,
  ProjectReferenceInfo,
} from "../types.js";
import {
  AnalyzerTreeItem,
  DependencyCategoryTreeItem,
  FrameworkReferenceTreeItem,
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  SolutionExplorerTreeItem,
} from "./treeItems.js";

/** A project's own `<ProjectReference>` entry, resolved to the referenced .csproj URI. */
interface ProjectReferenceEntry {
  name: string;
  uri: vscode.Uri;
  includePath: string;
}

/** Resolves the Dependencies subtree of a project: frameworks, analyzers, packages, project refs. */
export class DependencyTreeResolver {
  /** Cache of resolved dependency trees, keyed by .csproj fsPath. Invalidated on any filesystem
   * change (see `SolutionTreeDataProvider.scheduleRefresh`), so edits to the .csproj or a fresh
   * restore are picked up. */
  private readonly dependenciesCache = new Map<string, DependenciesInfo>();

  /** Cache of a project's own parsed project references, keyed by .csproj fsPath. Used both to
   * resolve the Projects category and to recursively expand transitive references. Invalidated on
   * any filesystem change (see `SolutionTreeDataProvider.scheduleRefresh`). */
  private readonly projectRefsCache = new Map<string, ProjectReferenceEntry[]>();

  /** Session cache of the newest stable version per package id (lowercased); `undefined` = lookup
   * failed. Deliberately NOT cleared in `clearCaches`: nuget.org versions don't change on local
   * file edits, so clearing it would re-fetch on every save. */
  private readonly latestStableCache = new Map<string, string | undefined>();

  clearCaches(): void {
    this.dependenciesCache.clear();
    this.projectRefsCache.clear();
  }

  async getDependenciesInfo(info: ProjectInfo): Promise<DependenciesInfo> {
    const cached = this.dependenciesCache.get(info.uri.fsPath);
    if (cached) {
      return cached;
    }
    const result = await this.resolveDependenciesInfo(info);
    this.dependenciesCache.set(info.uri.fsPath, result);
    return result;
  }

  /** The four dependency categories, in Visual Studio order, hiding empty ones. */
  getDependencyCategories(info: DependenciesInfo): SolutionExplorerTreeItem[] {
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

  async getCategoryChildren(
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

  /** Expands a project-reference node into the references its own target declares (transitively). */
  async expandProjectReference(info: ProjectReferenceInfo): Promise<SolutionExplorerTreeItem[]> {
    const entries = await this.readProjectReferences(info.uri);
    const children = entries.map((entry) =>
      this.toProjectReferenceInfo(entry, info.uri, info.ancestorFsPaths, true),
    );
    return Promise.all(children.map(async (child) => new ProjectReferenceTreeItem(await this.withHasChildren(child))));
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
