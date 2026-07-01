import * as vscode from "vscode";
import {
  AnalyzerInfo,
  DependencyCategory,
  DependencyCategoryInfo,
  ExcludedPaths,
  FrameworkReferenceInfo,
  FsEntry,
  OPEN_FILE_COMMAND_ID,
  PackageReferenceInfo,
  ProjectInfo,
  ProjectReferenceInfo,
  SolutionFolderInfo,
  SolutionInfo,
} from "./types.js";

const CATEGORY_LABEL: Record<DependencyCategory, string> = {
  frameworks: "Frameworks",
  analyzers: "Analyzers",
  packages: "Packages",
  projects: "Projects",
};

const CATEGORY_ICON: Record<DependencyCategory, string> = {
  frameworks: "layers",
  analyzers: "shield",
  packages: "package",
  projects: "project",
};

export class SolutionTreeItem extends vscode.TreeItem {
  constructor(public readonly info: SolutionInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `solution::${info.uri.fsPath}`;
    this.contextValue = "csharpSolutionExplorer.solution";
    this.iconPath = new vscode.ThemeIcon("folder-library");
    // Surface the file type (and folder, for nested/duplicate-named solutions) so root nodes are
    // clearly recognizable as solutions rather than plain folders.
    const ext = info.uri.fsPath.toLowerCase().endsWith(".slnx") ? ".slnx" : ".sln";
    this.description = info.relativeDir ? `${info.relativeDir} · ${ext}` : ext;
    this.tooltip = `Solution · ${info.uri.fsPath}`;
  }
}

export class SolutionFolderTreeItem extends vscode.TreeItem {
  constructor(public readonly info: SolutionFolderInfo) {
    super(
      info.name,
      info.isVirtual ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `solutionFolder::${info.solutionUri.fsPath}::${info.stableId}`;
    this.contextValue = info.isVirtual
      ? "csharpSolutionExplorer.pathSegmentFolder"
      : "csharpSolutionExplorer.solutionFolder";
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly info: ProjectInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    // Append `.nested` for projects inside a solution folder so "Remove from Solution Folder"
    // can be shown only when it actually applies.
    this.id = `project::${info.uri.fsPath}`;
    this.contextValue = info.parentFolderGuid
      ? "csharpSolutionExplorer.project.nested"
      : "csharpSolutionExplorer.project";
    this.resourceUri = info.uri;
    this.iconPath = vscode.ThemeIcon.File;
    if (info.isPseudoSolution) {
      this.description = "(no .sln found)";
    }
  }
}

export class DependenciesTreeItem extends vscode.TreeItem {
  // Carries only the owning project; the dependency tree is resolved lazily when this node expands,
  // so merely expanding a project doesn't read project.assets.json or any referenced .csproj.
  constructor(public readonly project: ProjectInfo) {
    super("Dependencies", vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "csharpSolutionExplorer.dependencies";
    this.iconPath = new vscode.ThemeIcon("library");
  }
}

export class DependencyCategoryTreeItem extends vscode.TreeItem {
  constructor(public readonly info: DependencyCategoryInfo) {
    super(CATEGORY_LABEL[info.category], vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = `csharpSolutionExplorer.dependencyCategory.${info.category}`;
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[info.category]);
  }
}

export class FrameworkReferenceTreeItem extends vscode.TreeItem {
  constructor(public readonly info: FrameworkReferenceInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "csharpSolutionExplorer.frameworkReference";
    this.description = info.version;
    this.iconPath = new vscode.ThemeIcon("layers");
  }
}

export class AnalyzerTreeItem extends vscode.TreeItem {
  constructor(public readonly info: AnalyzerInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "csharpSolutionExplorer.analyzer";
    this.description = info.version;
    this.iconPath = new vscode.ThemeIcon("shield");
  }
}

export class PackageReferenceTreeItem extends vscode.TreeItem {
  constructor(public readonly info: PackageReferenceInfo) {
    super(
      info.name,
      info.dependencies?.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    // Only direct references get the editable contextValue (Remove/Update); transitive ones are informational.
    // A direct package with a known newer version gets the `.outdated` suffix so "Update to Latest" can show.
    if (info.isImplicit) {
      this.contextValue = "csharpSolutionExplorer.packageReference.transitive";
    } else if (info.latestVersion) {
      this.contextValue = "csharpSolutionExplorer.packageReference.outdated";
    } else {
      this.contextValue = "csharpSolutionExplorer.packageReference";
    }
    if (info.latestVersion) {
      // Surface the available update inline (e.g. "9.0.0 → 9.6.0"), with a highlighted icon, like VS.
      this.description = `${info.version} → ${info.latestVersion}`;
      this.tooltip = `Update available: ${info.latestVersion}`;
      this.iconPath = new vscode.ThemeIcon("package", new vscode.ThemeColor("charts.yellow"));
    } else {
      this.description = info.version;
      // Transitive (pulled-in) packages are dimmed to distinguish them from direct references.
      this.iconPath = info.isImplicit
        ? new vscode.ThemeIcon("package", new vscode.ThemeColor("disabledForeground"))
        : new vscode.ThemeIcon("package");
    }
  }
}

export class ProjectReferenceTreeItem extends vscode.TreeItem {
  constructor(public readonly info: ProjectReferenceInfo) {
    super(
      info.name,
      info.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    // Transitive references are informational (no Remove); only direct ones get the editable contextValue.
    this.contextValue = info.isTransitive
      ? "csharpSolutionExplorer.projectReference.transitive"
      : "csharpSolutionExplorer.projectReference";
    this.resourceUri = info.uri;
    // Dim nested/transitive references so they read as "referenced indirectly", like transitive packages.
    this.iconPath = info.isTransitive
      ? new vscode.ThemeIcon("references", new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon("references");
    this.command = {
      command: OPEN_FILE_COMMAND_ID,
      title: "Open File",
      arguments: [info.uri],
    };
  }
}

export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: FsEntry,
    public readonly projectRootUri: vscode.Uri,
    public readonly excludedPaths: ExcludedPaths,
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `folder::${entry.uri.fsPath}`;
    this.contextValue = "csharpSolutionExplorer.folder";
    this.resourceUri = entry.uri;
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

export class FileTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: FsEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = `file::${entry.uri.fsPath}`;
    this.contextValue = entry.isExcluded
      ? "csharpSolutionExplorer.file.excluded"
      : "csharpSolutionExplorer.file";
    this.resourceUri = entry.uri;
    this.iconPath = entry.isExcluded
      ? new vscode.ThemeIcon("file", new vscode.ThemeColor("disabledForeground"))
      : vscode.ThemeIcon.File;
    if (entry.isExcluded) {
      this.description = "(excluded)";
      this.tooltip = "Excluded from the project by .csproj Include/Remove/Exclude rules.";
    }
    this.command = {
      command: OPEN_FILE_COMMAND_ID,
      title: "Open File",
      arguments: [entry.uri],
    };
  }
}

export class NestedFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: FsEntry,
    public readonly companions: FsEntry[],
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `file::${entry.uri.fsPath}`;
    this.contextValue = entry.isExcluded
      ? "csharpSolutionExplorer.file.excluded"
      : "csharpSolutionExplorer.file";
    this.resourceUri = entry.uri;
    this.iconPath = entry.isExcluded
      ? new vscode.ThemeIcon("file", new vscode.ThemeColor("disabledForeground"))
      : vscode.ThemeIcon.File;
    if (entry.isExcluded) {
      this.description = "(excluded)";
      this.tooltip = "Excluded from the project by .csproj Include/Remove/Exclude rules.";
    }
    this.command = {
      command: OPEN_FILE_COMMAND_ID,
      title: "Open File",
      arguments: [entry.uri],
    };
  }
}

export type SolutionExplorerTreeItem =
  | SolutionTreeItem
  | SolutionFolderTreeItem
  | ProjectTreeItem
  | DependenciesTreeItem
  | DependencyCategoryTreeItem
  | FrameworkReferenceTreeItem
  | AnalyzerTreeItem
  | PackageReferenceTreeItem
  | ProjectReferenceTreeItem
  | FolderTreeItem
  | FileTreeItem
  | NestedFileTreeItem;
