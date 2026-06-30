import * as vscode from "vscode";
import { SolutionTreeNode } from "./slnParser.js";

export const REFRESH_COMMAND_ID = "csharpSolutionExplorer.refresh";
export const OPEN_FILE_COMMAND_ID = "csharpSolutionExplorer.openFile";
export const NEW_CLASS_COMMAND_ID = "csharpSolutionExplorer.newClass";
export const NEW_INTERFACE_COMMAND_ID = "csharpSolutionExplorer.newInterface";
export const NEW_RECORD_COMMAND_ID = "csharpSolutionExplorer.newRecord";
export const NEW_ENUM_COMMAND_ID = "csharpSolutionExplorer.newEnum";
export const NEW_STRUCT_COMMAND_ID = "csharpSolutionExplorer.newStruct";
export const NEW_RAZOR_COMMAND_ID = "csharpSolutionExplorer.newRazor";
export const NEW_FILE_COMMAND_ID = "csharpSolutionExplorer.newFile";
export const NEW_FOLDER_COMMAND_ID = "csharpSolutionExplorer.newFolder";
export const NEW_SOLUTION_FOLDER_COMMAND_ID = "csharpSolutionExplorer.newSolutionFolder";
export const RENAME_COMMAND_ID = "csharpSolutionExplorer.rename";
export const DELETE_COMMAND_ID = "csharpSolutionExplorer.delete";
export const ADD_EXISTING_PROJECT_COMMAND_ID = "csharpSolutionExplorer.addExistingProject";
export const REMOVE_PROJECT_FROM_SOLUTION_COMMAND_ID = "csharpSolutionExplorer.removeProjectFromSolution";
export const ADD_PROJECT_REFERENCE_COMMAND_ID = "csharpSolutionExplorer.addProjectReference";
export const REMOVE_PROJECT_REFERENCE_COMMAND_ID = "csharpSolutionExplorer.removeProjectReference";
export const BUILD_PROJECT_COMMAND_ID = "csharpSolutionExplorer.buildProject";
export const RUN_PROJECT_COMMAND_ID = "csharpSolutionExplorer.runProject";
export const OPEN_SOLUTION_FILE_COMMAND_ID = "csharpSolutionExplorer.openSolutionFile";
export const OPEN_SETTINGS_COMMAND_ID = "csharpSolutionExplorer.openSettings";

export interface ProjectReference {
  typeGuid: string;
  name: string;
  relativePath: string;
  projectGuid: string;
}

export interface SolutionInfo {
  kind: "solution";
  name: string;
  uri: vscode.Uri;
  /** Workspace-folder-relative directory of the solution file, used to disambiguate
   * same-named solutions. Empty when the solution sits at the workspace folder root. */
  relativeDir?: string;
}

export interface ProjectInfo {
  kind: "project";
  name: string;
  uri: vscode.Uri;
  rootDir: vscode.Uri;
  isPseudoSolution: boolean;
  /** The .sln file this project is registered in, if any (absent for pseudo-solutions). */
  solutionUri?: vscode.Uri;
  /** The GUID of this project in the .sln file. */
  guid?: string;
  /** The GUID of the parent solution folder, if this project is nested. */
  parentFolderGuid?: string;
}

export interface SolutionFolderInfo {
  kind: "solutionFolder";
  name: string;
  guid: string;
  children: SolutionTreeNode[];
  solutionDir: vscode.Uri;
  solutionUri: vscode.Uri;
  /** True for synthetic path-segment nodes — no corresponding XML element, no context-menu actions. */
  isVirtual?: boolean;
}

export interface PackageReferenceInfo {
  kind: "packageReference";
  name: string;
  version?: string;
  /** True for transitive (pulled-in) packages rather than direct `<PackageReference>` entries. */
  isImplicit?: boolean;
  /** Transitive child packages, when known from project.assets.json. */
  dependencies?: PackageReferenceInfo[];
}

export interface ProjectReferenceInfo {
  kind: "projectReference";
  name: string;
  /** The referenced project's .csproj. */
  uri: vscode.Uri;
  /** The .csproj that declares this reference — the file edited on Remove. */
  ownerUri: vscode.Uri;
  /** The original `Include` value, used to remove the exact entry. */
  includePath: string;
  /** True for nested (transitive) references shown under a parent reference: dimmed, no Remove. */
  isTransitive?: boolean;
  /** Whether the referenced project itself declares project references (drives the expand arrow). */
  hasChildren?: boolean;
  /** fsPaths from the root project down to and including this reference's target, for cycle detection. */
  ancestorFsPaths: string[];
}

export interface FrameworkReferenceInfo {
  kind: "frameworkReference";
  name: string;
  version?: string;
}

export interface AnalyzerInfo {
  kind: "analyzer";
  name: string;
  version?: string;
}

export type DependencyCategory = "frameworks" | "analyzers" | "packages" | "projects";

export interface DependencyCategoryInfo {
  kind: "dependencyCategory";
  category: DependencyCategory;
  dependencies: DependenciesInfo;
}

export interface DependenciesInfo {
  kind: "dependencies";
  /** The owning project's .csproj, used as the write target when adding a project reference. */
  projectUri: vscode.Uri;
  frameworks: FrameworkReferenceInfo[];
  analyzers: AnalyzerInfo[];
  packages: PackageReferenceInfo[];
  projects: ProjectReferenceInfo[];
}

export type FsEntryKind = "folder" | "file";

export interface FsEntry {
  kind: FsEntryKind;
  name: string;
  uri: vscode.Uri;
  /** Whether the file is excluded from the project's items by .csproj Include/Remove/Exclude rules. Only meaningful for files. */
  isExcluded?: boolean;
}

/** Per-project-item-type excluded path sets, keyed by relative POSIX path from the project root. */
export interface ExcludedPaths {
  compile: Set<string>;
  none: Set<string>;
  content: Set<string>;
}
