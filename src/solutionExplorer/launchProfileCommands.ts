import * as path from "node:path";
import * as vscode from "vscode";
import { resolveOwningProjectUri } from "./commandUtils.js";
import { isDebuggableProject, parseOutputType, parseSdkAttribute } from "./csprojReader.js";
import {
  getActiveProfileName,
  getStartupProjectFsPath,
  NO_PROFILE,
  setActiveProfileName,
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
  resolveLaunchProfile,
  ResolvedLaunchProfile,
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

/**
 * The materialized launch profile (env/args/cwd/URL) a project would actually run with — shared by
 * the debugger's `launch` flow and the external-terminal `attach` flow, so the two agree by
 * construction. `opts` mirrors a `launch.json` entry's `noLaunchProfile`/`launchProfile` overrides;
 * omit both to fall back to the pinned/default profile the Solution Explorer status bar shows.
 */
export async function resolveActiveProfile(
  project: TargetProject,
  opts: { noLaunchProfile?: boolean; launchProfile?: string } = {},
): Promise<ResolvedLaunchProfile | undefined> {
  if (opts.noLaunchProfile) {
    return undefined;
  }
  const settings = await readLaunchSettings(project.rootDir);
  if (opts.launchProfile) {
    const named = findProfile(settings, opts.launchProfile);
    return named ? resolveLaunchProfile(named) : undefined;
  }
  const pinned = getActiveProfileName(project.uri.fsPath);
  if (pinned === NO_PROFILE) {
    return undefined;
  }
  const profile = (pinned !== undefined ? findProfile(settings, pinned) : undefined) ?? getDefaultProfile(settings);
  return profile ? resolveLaunchProfile(profile) : undefined;
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

/**
 * Reads a project file and classifies it as runnable/debuggable without invoking MSBuild
 * (see `isDebuggableProject`). A read failure defaults to `true` — fail open, so a project
 * is never hidden just because its file could not be read.
 */
async function isProjectDebuggable(uri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    return isDebuggableProject(parseSdkAttribute(text), parseOutputType(text));
  } catch {
    return true;
  }
}

interface StartupProjectQuickPickItem extends vscode.QuickPickItem {
  project?: TargetProject;
  showOthers?: boolean;
}

function toStartupProjectItem(project: TargetProject): StartupProjectQuickPickItem {
  return {
    label: project.name,
    description: vscode.workspace.asRelativePath(project.uri),
    project,
  };
}

/** Asks which project to start, and remembers it — the picker doubles as "set startup project". */
export async function promptForStartupProject(): Promise<TargetProject | undefined> {
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects were found in this workspace.");
    return undefined;
  }

  const debuggableFlags = await Promise.all(projects.map((project) => isProjectDebuggable(project.uri)));
  const debuggable = projects.filter((_, i) => debuggableFlags[i]);
  const others = projects.filter((_, i) => !debuggableFlags[i]);

  // Nothing to collapse (e.g. a solution of libraries only) — fall back to showing everything.
  const primaryList = debuggable.length > 0 ? debuggable : projects;
  const collapsedList = debuggable.length > 0 ? others : [];

  const items: StartupProjectQuickPickItem[] = primaryList.map(toStartupProjectItem);
  if (collapsedList.length > 0) {
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      {
        label: `Show ${collapsedList.length} other project${collapsedList.length === 1 ? "" : "s"} (not runnable)`,
        showOthers: true,
      },
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Startup project",
    placeHolder: "Select the project to run",
  });
  if (!picked) {
    return undefined;
  }

  let project = picked.project;
  if (picked.showOthers) {
    const pickedOther = await vscode.window.showQuickPick(collapsedList.map(toStartupProjectItem), {
      title: "Startup project — not runnable",
      placeHolder: "Select the project to run",
    });
    project = pickedOther?.project;
  }
  if (!project) {
    return undefined;
  }

  setStartupProject(project.uri.fsPath);
  return project;
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
