import * as path from "node:path";
import * as vscode from "vscode";
import { resolveOwningProjectUri } from "./commandUtils.js";
import {
  getActiveProfileName,
  getLaunchBrowserOverride,
  getStartupProjectFsPath,
  NO_PROFILE,
  setActiveProfileName,
  setLaunchBrowserOverride,
  setStartupProject,
} from "./launchProfileState.js";
import {
  findProfile,
  getDefaultProfile,
  getLaunchSettingsPath,
  isRunnableProfile,
  LaunchProfile,
  ParsedLaunchSettings,
  parseLaunchSettings,
} from "./launchSettingsReader.js";

const EXCLUDE_GLOB = "**/{bin,obj,node_modules,.git,.vs}/**";

/**
 * Reads a project's launch profiles. A missing or unreadable file is not an error — it just means
 * the project has no profiles, so callers get an empty result rather than having to null-check.
 */
export async function readLaunchSettings(projectRootDir: vscode.Uri): Promise<ParsedLaunchSettings> {
  const uri = vscode.Uri.file(getLaunchSettingsPath(projectRootDir.fsPath));
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseLaunchSettings(new TextDecoder().decode(bytes));
  } catch {
    return { profiles: [] };
  }
}

/**
 * The profile name to pass to `dotnet run` for a project:
 * - the pinned profile, when it still exists;
 * - `NO_PROFILE` when the user explicitly opted out;
 * - undefined otherwise, so the CLI picks the file's own default (which stays correct when the
 *   file changes behind our back).
 */
export async function resolveActiveProfileName(
  projectUri: vscode.Uri,
  projectRootDir: vscode.Uri,
): Promise<string | undefined> {
  const pinned = getActiveProfileName(projectUri.fsPath);
  if (pinned === undefined) {
    return undefined;
  }
  if (pinned === NO_PROFILE) {
    return NO_PROFILE;
  }
  const settings = await readLaunchSettings(projectRootDir);
  return findProfile(settings, pinned)?.name;
}

export async function setStartupProjectCommand(item: unknown): Promise<void> {
  const uri = resolveOwningProjectUri(item);
  if (!uri) {
    return;
  }
  setStartupProject(uri.fsPath);
}

export function clearStartupProjectCommand(): void {
  // The per-project profile choices are kept, so re-setting the same startup project restores it.
  setStartupProject(undefined);
}

/**
 * Picks (and remembers) the startup project without needing a tree node — the entry point used by
 * the status bar and the command palette. `setStartupProjectCommand` covers the tree-node case.
 */
export async function selectStartupProjectCommand(): Promise<void> {
  await promptForStartupProject();
}

/**
 * The status bar's click target: a small Visual-Studio-toolbar-style menu to change the startup
 * project, its launch profile, or the "launch browser" switch — all behind one obvious control.
 */
export async function manageLaunchCommand(): Promise<void> {
  const startup = getStartupProjectFsPath();
  const CHANGE_PROJECT = "$(project) Change startup project…";
  const CHANGE_PROFILE = "$(rocket) Change launch profile…";
  const items = [CHANGE_PROJECT];
  let toggleBrowser: string | undefined;
  if (startup) {
    items.push(CHANGE_PROFILE);
    const uri = vscode.Uri.file(startup);
    const on = await getEffectiveLaunchBrowser(uri, vscode.Uri.file(path.dirname(startup)));
    toggleBrowser = on ? "$(globe) Launch browser: On" : "$(globe) Launch browser: Off";
    items.push(toggleBrowser);
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Debug / Run",
    placeHolder: "Choose what to change",
  });
  if (picked === CHANGE_PROJECT) {
    await selectStartupProjectCommand();
  } else if (picked === CHANGE_PROFILE) {
    await selectLaunchProfileCommand();
  } else if (picked !== undefined && picked === toggleBrowser) {
    await toggleLaunchBrowserCommand();
  }
}

/**
 * The effective "launch browser" flag for a project: the per-project override if set, otherwise the
 * active launch profile's own `launchBrowser` (Visual Studio's model — the flag lives in the
 * profile). Drives whether debugging opens the browser once the server is ready.
 */
export async function getEffectiveLaunchBrowser(projectUri: vscode.Uri, projectRootDir: vscode.Uri): Promise<boolean> {
  const override = getLaunchBrowserOverride(projectUri.fsPath);
  if (override !== undefined) {
    return override;
  }
  const { profile } = await describeActiveProfile(projectUri, projectRootDir);
  return profile?.launchBrowser ?? false;
}

/** Flips the "launch browser" switch for a project (the startup project when invoked with no node). */
export async function toggleLaunchBrowserCommand(item?: unknown): Promise<void> {
  const project = (await resolveTargetProject(item)) ?? (await promptForStartupProject());
  if (!project) {
    return;
  }
  const next = !(await getEffectiveLaunchBrowser(project.uri, project.rootDir));
  setLaunchBrowserOverride(project.uri.fsPath, next);
  vscode.window.showInformationMessage(`Launch browser ${next ? "enabled" : "disabled"} for ${project.name}.`);
}

/**
 * Picks the launch profile for a project. Invoked from a project node (that project), or from the
 * status bar / command palette with no argument (the startup project, choosing one first if none
 * is set yet).
 */
export async function selectLaunchProfileCommand(item?: unknown): Promise<void> {
  const project = (await resolveTargetProject(item)) ?? (await promptForStartupProject());
  if (!project) {
    return;
  }

  const settings = await readLaunchSettings(project.rootDir);
  const runnable = settings.profiles.filter(isRunnableProfile);
  const unsupported = settings.profiles.filter((p) => !isRunnableProfile(p));

  if (settings.profiles.length === 0) {
    vscode.window.showInformationMessage(
      `${project.name} has no launch profiles (${path.join("Properties", "launchSettings.json")}).`,
    );
    return;
  }

  const active = getActiveProfileName(project.uri.fsPath);
  const picked = await vscode.window.showQuickPick(buildProfileItems(runnable, unsupported, active), {
    title: `Launch profile — ${project.name}`,
    placeHolder: "Select the profile to run this project with",
  });
  if (!picked) {
    return;
  }
  if (picked.unsupported) {
    vscode.window.showInformationMessage(
      `The "${picked.profileName ?? ""}" profile uses commandName "${picked.commandName ?? ""}", which is not supported. Only "Project" profiles can be run.`,
    );
    return;
  }

  setActiveProfileName(project.uri.fsPath, picked.profileName);
}

export interface TargetProject {
  name: string;
  uri: vscode.Uri;
  rootDir: vscode.Uri;
}

/** All projects in the workspace, sorted by name. Shared with the debugger's project picker. */
export async function findWorkspaceProjects(): Promise<TargetProject[]> {
  const uris = await vscode.workspace.findFiles("**/*.{csproj,fsproj,vbproj}", EXCLUDE_GLOB);
  return uris.map(toTargetProject).sort((a, b) => a.name.localeCompare(b.name));
}

export function projectFromUri(uri: vscode.Uri): TargetProject {
  return toTargetProject(uri);
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  /** undefined clears the pin (fall back to the file's default); `NO_PROFILE` opts out entirely. */
  profileName?: string;
  unsupported?: boolean;
  commandName?: string;
}

function buildProfileItems(
  runnable: LaunchProfile[],
  unsupported: LaunchProfile[],
  active: string | undefined,
): ProfileQuickPickItem[] {
  const items: ProfileQuickPickItem[] = runnable.map((profile) => ({
    label: profile.name === active ? `$(check) ${profile.name}` : profile.name,
    description: profile.applicationUrl,
    detail: profile.commandLineArgs,
    profileName: profile.name,
  }));

  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: active === NO_PROFILE ? "$(check) Run without a launch profile" : "Run without a launch profile",
      description: "dotnet run --no-launch-profile",
      profileName: NO_PROFILE,
    },
    {
      label: active === undefined ? "$(check) Use the default profile" : "Use the default profile",
      description: "Let the .NET SDK choose",
      profileName: undefined,
    },
  );

  if (unsupported.length > 0) {
    // Shown rather than hidden, so it is clear *why* a profile from the file is not offered.
    items.push(
      { label: "Not supported", kind: vscode.QuickPickItemKind.Separator },
      ...unsupported.map((profile) => ({
        label: `$(circle-slash) ${profile.name}`,
        description: profile.commandName,
        unsupported: true,
        profileName: profile.name,
        commandName: profile.commandName,
      })),
    );
  }

  return items;
}

async function resolveTargetProject(item: unknown): Promise<TargetProject | undefined> {
  const fromNode = resolveOwningProjectUri(item);
  if (fromNode) {
    return toTargetProject(fromNode);
  }
  const startup = getStartupProjectFsPath();
  return startup ? toTargetProject(vscode.Uri.file(startup)) : undefined;
}

/** Asks which project to start, and remembers it — the picker doubles as "set startup project". */
export async function promptForStartupProject(): Promise<TargetProject | undefined> {
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects were found in this workspace.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name,
      description: vscode.workspace.asRelativePath(project.uri),
      project,
    })),
    { title: "Startup project", placeHolder: "Select the project to run" },
  );
  if (!picked) {
    return undefined;
  }

  setStartupProject(picked.project.uri.fsPath);
  return picked.project;
}

function toTargetProject(uri: vscode.Uri): TargetProject {
  return {
    name: path.basename(uri.fsPath, path.extname(uri.fsPath)),
    uri,
    rootDir: vscode.Uri.file(path.dirname(uri.fsPath)),
  };
}

/** The profile a project will actually run with, for display. */
export async function describeActiveProfile(
  projectUri: vscode.Uri,
  projectRootDir: vscode.Uri,
): Promise<{ label: string; profile?: LaunchProfile }> {
  const pinned = getActiveProfileName(projectUri.fsPath);
  if (pinned === NO_PROFILE) {
    return { label: "no profile" };
  }

  const settings = await readLaunchSettings(projectRootDir);
  const profile = (pinned !== undefined ? findProfile(settings, pinned) : undefined) ?? getDefaultProfile(settings);
  if (!profile) {
    return { label: "no profile" };
  }
  return { label: pinned !== undefined && profile.name === pinned ? profile.name : `${profile.name} (default)`, profile };
}
