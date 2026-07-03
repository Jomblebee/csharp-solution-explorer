import * as vscode from "vscode";
import { ProjectTreeItem, SolutionTreeItem } from "./treeItems.js";

// Build/Rebuild/Test/Restore/Clean accept both a project (.csproj) and a solution (.sln/.slnx) path;
// both tree items carry `info.uri`.
export function buildTarget(item: ProjectTreeItem | SolutionTreeItem): void {
  runInTerminal("C# Solution Explorer: Build", `dotnet build "${item.info.uri.fsPath}"`);
}

// `--no-incremental` forces a full recompile in a single command, so it works in every shell
// (cmd, PowerShell 5/7, bash, zsh) unlike a chained `clean && build`.
export function rebuildTarget(item: ProjectTreeItem | SolutionTreeItem): void {
  runInTerminal("C# Solution Explorer: Build", `dotnet build "${item.info.uri.fsPath}" --no-incremental`);
}

export function testTarget(item: ProjectTreeItem | SolutionTreeItem): void {
  runInTerminal("C# Solution Explorer: Test", `dotnet test "${item.info.uri.fsPath}"`);
}

export function runProject(item: ProjectTreeItem): void {
  runInTerminal("C# Solution Explorer: Run", `dotnet run --project "${item.info.uri.fsPath}"`);
}

export function restoreTarget(item: ProjectTreeItem | SolutionTreeItem): void {
  runInTerminal("C# Solution Explorer: Restore", `dotnet restore "${item.info.uri.fsPath}"`);
}

export function cleanTarget(item: ProjectTreeItem | SolutionTreeItem): void {
  runInTerminal("C# Solution Explorer: Clean", `dotnet clean "${item.info.uri.fsPath}"`);
}

function runInTerminal(name: string, command: string): void {
  const terminal = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal(name);
  terminal.show();
  terminal.sendText(command);
}
