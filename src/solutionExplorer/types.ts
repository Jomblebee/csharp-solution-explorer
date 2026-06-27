import * as vscode from "vscode";
import { SolutionTreeNode } from "./slnParser.js";

export const REFRESH_COMMAND_ID = "csharpSolutionExplorer.refresh";
export const OPEN_FILE_COMMAND_ID = "csharpSolutionExplorer.openFile";
export const NEW_CLASS_COMMAND_ID = "csharpSolutionExplorer.newClass";
export const NEW_FOLDER_COMMAND_ID = "csharpSolutionExplorer.newFolder";
export const RENAME_COMMAND_ID = "csharpSolutionExplorer.rename";
export const DELETE_COMMAND_ID = "csharpSolutionExplorer.delete";
export const BUILD_PROJECT_COMMAND_ID = "csharpSolutionExplorer.buildProject";
export const RUN_PROJECT_COMMAND_ID = "csharpSolutionExplorer.runProject";

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
}

export interface ProjectInfo {
  kind: "project";
  name: string;
  uri: vscode.Uri;
  rootDir: vscode.Uri;
  isPseudoSolution: boolean;
  /** The .sln file this project is registered in, if any (absent for pseudo-solutions). */
  solutionUri?: vscode.Uri;
}

export interface SolutionFolderInfo {
  kind: "solutionFolder";
  name: string;
  children: SolutionTreeNode[];
  solutionDir: vscode.Uri;
  solutionUri: vscode.Uri;
}

export interface PackageReferenceInfo {
  kind: "packageReference";
  name: string;
  version?: string;
}

export interface ProjectReferenceInfo {
  kind: "projectReference";
  name: string;
  uri: vscode.Uri;
}

export interface DependenciesInfo {
  kind: "dependencies";
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
