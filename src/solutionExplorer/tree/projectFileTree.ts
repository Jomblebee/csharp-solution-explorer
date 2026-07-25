import * as vscode from "vscode";
import { isImplicitItemGlobEnabled, parseItemRules, resolveExcludedPaths } from "../parsers/csprojReader.js";
import { listAllFilesRecursive, listDirectChildren, ScannedEntry } from "../diskScanner.js";
import { toPosixRelative } from "../fsPathUtils.js";
import { computeFileNesting } from "./fileNesting.js";
import { ExcludedPaths, ProjectInfo } from "../types.js";
import { FileTreeItem, FolderTreeItem, NestedFileTreeItem, SolutionExplorerTreeItem } from "./treeItems.js";

/** Builds the file/folder part of a project's subtree, honouring the project's item excludes. */
export class ProjectFileTreeBuilder {
  /** Cache of resolved excluded-item sets, keyed by .csproj fsPath. Invalidated on any
   * filesystem change (see `SolutionTreeDataProvider.scheduleRefresh`), since a changed file could
   * affect glob resolution for any project. */
  private readonly excludedPathsCache = new Map<string, ExcludedPaths>();

  clearCaches(): void {
    this.excludedPathsCache.clear();
  }

  async getExcludedPaths(info: ProjectInfo): Promise<ExcludedPaths> {
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

  getFsChildren(
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
}
