import * as vscode from "vscode";
import { resolveOwningProjectUri } from "../commandUtils.js";
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
  resolveLaunchProfile,
  ResolvedLaunchProfile,
} from "../parsers/launchSettingsReader.js";
import { readLaunchSettings } from "./launchSettingsIo.js";
import { promptForStartupProject, resolveTargetProject, TargetProject } from "../workspaceProjects.js";
import { addProfile, deleteProfile, duplicateProfile, editProfile } from "./launchProfileEditor.js";
import { isWebSdk, parseSdkAttribute, parseTargetFrameworks } from "../parsers/csprojReader.js";

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
 * is set yet). Each profile carries pencil/copy/trash buttons to edit/duplicate/delete it, and a
 * "New profile…" entry creates one — all via built-in dialogs, writing launchSettings.json directly.
 */
export async function selectLaunchProfileCommand(item?: unknown): Promise<void> {
  const project = (await resolveTargetProject(item)) ?? (await promptForStartupProject());
  if (!project) {
    return;
  }
  await showProfilePicker(project);
}

const EDIT_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("pencil"), tooltip: "Edit profile" };
const DUPLICATE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Duplicate profile" };
const DELETE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete profile" };
const OPEN_FILE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("go-to-file"),
  tooltip: "Open launchSettings.json",
};

const ASPNETCORE_ENVIRONMENT = "ASPNETCORE_ENVIRONMENT";

/** SDK-level facts read once per picker — the project file does not change while it is open. */
async function readProjectFacts(projectUri: vscode.Uri): Promise<{ webSdk: boolean; tfm: string }> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri));
    return { webSdk: isWebSdk(parseSdkAttribute(text)), tfm: parseTargetFrameworks(text).join(" · ") };
  } catch {
    return { webSdk: false, tfm: "" };
  }
}

/** Opens the raw launchSettings.json in a text editor, or says so when the project has none yet. */
async function openLaunchSettingsFile(project: TargetProject): Promise<void> {
  const uri = vscode.Uri.file(getLaunchSettingsPath(project.rootDir.fsPath));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    vscode.window.showInformationMessage(`${project.name} has no launchSettings.json yet.`);
    return;
  }
  await vscode.window.showTextDocument(uri);
}

/**
 * The live profile picker. A `createQuickPick` (not `showQuickPick`) so real profiles can carry
 * per-item buttons; picking a profile pins it, the buttons run the editor flows, and the picker is
 * reloaded and re-shown afterwards so its state stays current.
 */
async function showProfilePicker(project: TargetProject): Promise<void> {
  const { webSdk, tfm } = await readProjectFacts(project.uri);
  const qp = vscode.window.createQuickPick<ProfileQuickPickItem>();
  qp.title = `Launch profile — ${project.name}${tfm ? ` (${tfm})` : ""}`;
  qp.placeholder = "Select a profile to run, or use the buttons to edit / add profiles";

  const reload = async (): Promise<void> => {
    const settings = await readLaunchSettings(project.rootDir);
    const runnable = settings.profiles.filter(isRunnableProfile);
    const unsupported = settings.profiles.filter((p) => !isRunnableProfile(p));
    const active = getActiveProfileName(project.uri.fsPath);
    const items = buildProfileItems(runnable, unsupported, active, webSdk);
    qp.items = items;
    const preselect = pickActiveItem(items, active);
    if (preselect) {
      qp.activeItems = [preselect];
    }
  };

  return new Promise<void>((resolve) => {
    const done = (): void => {
      qp.dispose();
      resolve();
    };

    qp.onDidTriggerItemButton(async (event) => {
      if (event.button === OPEN_FILE_BUTTON) {
        qp.hide();
        await openLaunchSettingsFile(project);
        done();
        return;
      }
      const name = event.item.profileName;
      if (!name || name === NO_PROFILE) {
        return; // synthetic items have no editable profile
      }
      qp.hide();
      if (event.button === EDIT_BUTTON) {
        await editProfile(project, name);
      } else if (event.button === DUPLICATE_BUTTON) {
        await duplicateProfile(project, name);
      } else if (event.button === DELETE_BUTTON) {
        await deleteProfile(project, name);
      }
      await reload();
      qp.show();
    });

    qp.onDidAccept(async () => {
      const [picked] = qp.selectedItems;
      if (!picked) {
        return;
      }
      if (picked.newProfile) {
        qp.hide();
        await addProfile(project);
        await reload();
        qp.show();
        return;
      }
      if (picked.unsupported) {
        vscode.window.showInformationMessage(
          `The "${picked.profileName ?? ""}" profile uses commandName "${picked.commandName ?? ""}", which is not supported. Only "Project" profiles can be run.`,
        );
        return;
      }
      setActiveProfileName(project.uri.fsPath, picked.profileName);
      done();
    });

    qp.onDidHide(done);
    void reload().then(() => qp.show());
  });
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  /** undefined clears the pin (fall back to the file's default); `NO_PROFILE` opts out entirely. */
  profileName?: string;
  unsupported?: boolean;
  commandName?: string;
  newProfile?: boolean;
  /** Marks the synthetic "Use the default profile" row (its `profileName` is a meaningful undefined). */
  isDefault?: boolean;
}

/** The row matching the current pin, so the picker opens with it highlighted (Enter re-confirms). */
function pickActiveItem(items: ProfileQuickPickItem[], active: string | undefined): ProfileQuickPickItem | undefined {
  if (active === undefined) {
    return items.find((item) => item.isDefault);
  }
  if (active === NO_PROFILE) {
    return items.find((item) => item.profileName === NO_PROFILE);
  }
  return items.find((item) => item.profileName === active && !item.unsupported);
}

function buildProfileItems(
  runnable: LaunchProfile[],
  unsupported: LaunchProfile[],
  active: string | undefined,
  webSdk: boolean,
): ProfileQuickPickItem[] {
  const buttons = [EDIT_BUTTON, DUPLICATE_BUTTON, DELETE_BUTTON, OPEN_FILE_BUTTON];
  const items: ProfileQuickPickItem[] = runnable.map((profile) => {
    const isWeb = profile.applicationUrl !== undefined || webSdk;
    const icon = isWeb ? "$(globe)" : "$(terminal)";
    const env = profile.environmentVariables[ASPNETCORE_ENVIRONMENT];
    return {
      label: `${profile.name === active ? "$(check) " : ""}${icon} ${profile.name}`,
      description: isWeb ? profile.applicationUrl : profile.commandLineArgs,
      detail: env ? `$(server-environment) ${env}` : undefined,
      profileName: profile.name,
      buttons,
    };
  });

  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) New profile...", newProfile: true },
    {
      label: active === NO_PROFILE ? "$(check) Run without a launch profile" : "Run without a launch profile",
      description: "dotnet run --no-launch-profile",
      profileName: NO_PROFILE,
    },
    {
      label: active === undefined ? "$(check) Use the default profile" : "Use the default profile",
      description: "Let the .NET SDK choose",
      profileName: undefined,
      isDefault: true,
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
        buttons,
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
