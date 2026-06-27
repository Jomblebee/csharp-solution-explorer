import * as vscode from "vscode";

export const REFRESH_COMMAND_ID = "jfksharp.solutionExplorer.refresh";
export const OPEN_FILE_COMMAND_ID = "jfksharp.solutionExplorer.openFile";

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
}

export type FsEntryKind = "folder" | "file";

export interface FsEntry {
  kind: FsEntryKind;
  name: string;
  uri: vscode.Uri;
}
