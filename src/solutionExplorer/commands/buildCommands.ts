import * as vscode from "vscode";
import { CANCELLED, resolveOwningProjectUri, resolveRunFramework } from "../commandUtils.js";
import { runInExternalTerminal } from "../externalTerminal.js";
import { resolveActiveProfileName } from "../launchProfiles/launchProfileCommands.js";
import { projectFromUri, promptForStartupProject, TargetProject } from "../workspaceProjects.js";
import { getStartupProjectFsPath, NO_PROFILE } from "../launchProfiles/launchProfileState.js";
import { ProjectTreeItem, SolutionTreeItem } from "../tree/treeItems.js";

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

/**
 * Runs a project with its selected launch profile. The profile itself is applied by the `dotnet`
 * CLI (`--launch-profile`), so environment variables and URLs need no handling here.
 */
export async function runProject(item: ProjectTreeItem): Promise<void> {
  const command = await buildRunCommand(item.info.uri, item.info.name, item.info.rootDir);
  if (command) {
    runInTerminal("C# Solution Explorer: Run", command);
  }
}

/**
 * Runs a project in a native OS terminal window (no debugger). Invoked from a project node, or from
 * the status bar / command palette with no argument (the startup project, choosing one if none is
 * set). This is the only way to get a real console for the program — netcoredbg keeps a *debugged*
 * program's output in the Debug Console.
 */
export async function runProjectInExternalTerminal(item?: unknown): Promise<void> {
  const project = await resolveRunTarget(item);
  if (!project) {
    return;
  }
  const command = await buildRunCommand(project.uri, project.name, project.rootDir);
  if (command) {
    await runInExternalTerminal(project.rootDir.fsPath, command);
  }
}

/** Builds the `dotnet run` command line (framework + launch profile), or undefined if cancelled. */
async function buildRunCommand(uri: vscode.Uri, name: string, rootDir: vscode.Uri): Promise<string | undefined> {
  const framework = await resolveRunFramework(uri, name);
  if (framework === CANCELLED) {
    return undefined;
  }
  const profile = await resolveActiveProfileName(uri, rootDir);

  const parts = [`dotnet run --project "${uri.fsPath}"`];
  if (framework) {
    parts.push(`--framework ${framework}`);
  }
  if (profile === NO_PROFILE) {
    parts.push("--no-launch-profile");
  } else if (profile) {
    // Profile names legitimately contain spaces ("IIS Express"), so always quote.
    parts.push(`--launch-profile "${profile}"`);
  }
  return parts.join(" ");
}

/** The project to run: the clicked tree node, else the startup project, else a prompt. */
async function resolveRunTarget(item: unknown): Promise<TargetProject | undefined> {
  const fromNode = resolveOwningProjectUri(item);
  if (fromNode) {
    return projectFromUri(fromNode);
  }
  const startup = getStartupProjectFsPath();
  if (startup) {
    return projectFromUri(vscode.Uri.file(startup));
  }
  return (await promptForStartupProject()) ?? undefined;
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
