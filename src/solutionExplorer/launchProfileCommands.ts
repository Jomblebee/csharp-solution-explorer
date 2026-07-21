import * as path from "node:path";
import * as vscode from "vscode";
import { resolveOwningProjectUri } from "./commandUtils.js";
import {
  getActiveProfileName,
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
import { promptForStartupProject, resolveTargetProject, TargetProject } from "./workspaceProjects.js";

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
