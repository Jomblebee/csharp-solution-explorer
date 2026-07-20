import * as vscode from "vscode";

/**
 * The workspace's startup project and the launch profile picked per project — the state behind the
 * status bar item and the tree's startup decoration. Held in a module singleton (like
 * `treeClipboard.ts`) rather than on the tree provider, because `toProjectInfo` needs to read the
 * startup project synchronously while building every project node.
 */

/** Persisted fsPath of the startup project. */
const STARTUP_KEY = "csharpSolutionExplorer.startupProject";
/** Persisted map of project fsPath → chosen launch profile name. */
const PROFILES_KEY = "csharpSolutionExplorer.launchProfiles";
/** Persisted map of project fsPath → "launch browser" override (unset = follow the profile). */
const LAUNCH_BROWSER_KEY = "csharpSolutionExplorer.launchBrowser";
/** Context key so "Clear Startup Project" only shows once one is set. */
const CONTEXT_KEY = "csharpSolutionExplorer.hasStartupProject";

/**
 * Marks "run this project with no profile at all" (`dotnet run --no-launch-profile`), which is a
 * different choice from having picked nothing yet (then the CLI applies the file's default).
 */
export const NO_PROFILE = " none";

let workspaceState: vscode.Memento | undefined;
let startupProjectFsPath: string | undefined;
let profileNames: Record<string, string> = {};
let launchBrowserOverrides: Record<string, boolean> = {};

const emitter = new vscode.EventEmitter<void>();

/** Fires whenever the startup project or a project's launch profile changes. */
export const onDidChangeLaunchProfileState = emitter.event;

/**
 * Hydrates the persisted state. Must run before the tree provider is constructed, otherwise the
 * first render draws the startup project undecorated.
 */
export function initLaunchProfileState(context: vscode.ExtensionContext): void {
  workspaceState = context.workspaceState;
  startupProjectFsPath = context.workspaceState.get<string>(STARTUP_KEY);
  profileNames = context.workspaceState.get<Record<string, string>>(PROFILES_KEY) ?? {};
  launchBrowserOverrides = context.workspaceState.get<Record<string, boolean>>(LAUNCH_BROWSER_KEY) ?? {};
  // Mirror the context key immediately so menus are correct on the first render after a reload.
  void vscode.commands.executeCommand("setContext", CONTEXT_KEY, startupProjectFsPath !== undefined);
}

/**
 * The startup project's fsPath, or undefined when none is set. Deliberately cheap and synchronous
 * (no `stat`): it is called once per project on every tree render, so a stale path simply decorates
 * nothing.
 */
export function getStartupProjectFsPath(): string | undefined {
  return startupProjectFsPath;
}

export function setStartupProject(projectFsPath: string | undefined): void {
  startupProjectFsPath = projectFsPath;
  void workspaceState?.update(STARTUP_KEY, projectFsPath);
  void vscode.commands.executeCommand("setContext", CONTEXT_KEY, projectFsPath !== undefined);
  emitter.fire();
}

/** The profile pinned for a project, or undefined when the user has not chosen one. */
export function getActiveProfileName(projectFsPath: string): string | undefined {
  return profileNames[projectFsPath];
}

/** Passing undefined forgets the choice, so the project falls back to the file's default profile. */
export function setActiveProfileName(projectFsPath: string, name: string | undefined): void {
  if (name === undefined) {
    delete profileNames[projectFsPath];
  } else {
    profileNames[projectFsPath] = name;
  }
  void workspaceState?.update(PROFILES_KEY, profileNames);
  emitter.fire();
}

/**
 * The per-project "launch browser" override, or undefined when the project follows its launch
 * profile's own `launchBrowser`. Kept separate from the profile file so toggling it needs no edit to
 * the user's `launchSettings.json`.
 */
export function getLaunchBrowserOverride(projectFsPath: string): boolean | undefined {
  return launchBrowserOverrides[projectFsPath];
}

/** Passing undefined forgets the override, so the project falls back to the profile's own value. */
export function setLaunchBrowserOverride(projectFsPath: string, value: boolean | undefined): void {
  if (value === undefined) {
    delete launchBrowserOverrides[projectFsPath];
  } else {
    launchBrowserOverrides[projectFsPath] = value;
  }
  void workspaceState?.update(LAUNCH_BROWSER_KEY, launchBrowserOverrides);
  emitter.fire();
}

export function disposeLaunchProfileState(): void {
  emitter.dispose();
}
