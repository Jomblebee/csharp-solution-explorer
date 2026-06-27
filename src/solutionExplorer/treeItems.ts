import * as vscode from "vscode";
import { FsEntry, OPEN_FILE_COMMAND_ID, ProjectInfo, SolutionInfo } from "./types.js";

export class SolutionTreeItem extends vscode.TreeItem {
  constructor(public readonly info: SolutionInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "jfksharp.solution";
    this.iconPath = new vscode.ThemeIcon("folder-library");
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly info: ProjectInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "jfksharp.project";
    this.resourceUri = info.uri;
    this.iconPath = vscode.ThemeIcon.File;
    if (info.isPseudoSolution) {
      this.description = "(no .sln found)";
    }
  }
}

export class FolderTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: FsEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "jfksharp.folder";
    this.resourceUri = entry.uri;
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

export class FileTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: FsEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "jfksharp.file";
    this.resourceUri = entry.uri;
    this.iconPath = vscode.ThemeIcon.File;
    this.command = {
      command: OPEN_FILE_COMMAND_ID,
      title: "Open File",
      arguments: [entry.uri],
    };
  }
}

export type SolutionExplorerTreeItem = SolutionTreeItem | ProjectTreeItem | FolderTreeItem | FileTreeItem;
