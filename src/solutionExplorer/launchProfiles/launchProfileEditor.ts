// Editing launch profiles through built-in VS Code dialogs (QuickPick + InputBox) — no webview. The
// profile picker (launchProfileCommands) opens these flows via its per-item pencil/copy/trash
// buttons and a "New profile…" entry. Every change is written to launchSettings.json immediately via
// the pure, round-tripping `launchSettingsWriter`, so unknown keys the reader does not model survive.

import * as vscode from "vscode";
import { LaunchProfile, ParsedLaunchSettings, findProfile } from "../parsers/launchSettingsReader.js";
import { readLaunchSettings, readLaunchSettingsRaw, writeLaunchSettings } from "./launchProfileCommands.js";
import {
  applyLaunchSettingsEdit,
  EditableProfileFields,
  LaunchSettingsEdit,
} from "../parsers/launchSettingsWriter.js";
import { getActiveProfileName, setActiveProfileName } from "./launchProfileState.js";
import { TargetProject } from "../workspaceProjects.js";
import { isWebSdk, parseSdkAttribute } from "../parsers/csprojReader.js";
import {
  buildApplicationUrl,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parseApplicationUrl,
  UrlPorts,
  UrlScheme,
} from "./launchProfileUrls.js";

/** The `commandName`s worth offering; `Project` is the one that actually runs the project itself. */
const COMMAND_NAMES = ["Project", "Executable", "IISExpress"];

function toEditable(profile: LaunchProfile): EditableProfileFields {
  return {
    commandName: profile.commandName,
    executablePath: profile.executablePath,
    commandLineArgs: profile.commandLineArgs,
    workingDirectory: profile.workingDirectory,
    applicationUrl: profile.applicationUrl,
    launchUrl: profile.launchUrl,
    launchBrowser: profile.launchBrowser,
    dotnetRunMessages: profile.dotnetRunMessages,
    environmentVariables: { ...profile.environmentVariables },
  };
}

/** A full snapshot of every profile's editable fields, in order — the base every mutation edits. */
function snapshot(settings: ParsedLaunchSettings): { order: string[]; profiles: Record<string, EditableProfileFields> } {
  const order: string[] = [];
  const profiles: Record<string, EditableProfileFields> = {};
  for (const profile of settings.profiles) {
    order.push(profile.name);
    profiles[profile.name] = toEditable(profile);
  }
  return { order, profiles };
}

async function persist(project: TargetProject, edit: LaunchSettingsEdit): Promise<void> {
  const raw = await readLaunchSettingsRaw(project.rootDir);
  await writeLaunchSettings(project.rootDir, applyLaunchSettingsEdit(raw, edit));
}

/** Case-insensitive, matching `findProfile`; `except` lets a profile keep its own name on rename. */
function nameExists(settings: ParsedLaunchSettings, name: string, except?: string): boolean {
  const wanted = name.toLowerCase();
  return settings.profiles.some((p) => p.name.toLowerCase() === wanted && p.name.toLowerCase() !== except?.toLowerCase());
}

async function promptProfileName(
  settings: ParsedLaunchSettings,
  opts: { title: string; value?: string; except?: string },
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: opts.title,
    value: opts.value,
    validateInput: (input) => {
      const trimmed = input.trim();
      if (trimmed.length === 0) {
        return "Enter a profile name.";
      }
      if (nameExists(settings, trimmed, opts.except)) {
        return `A profile named "${trimmed}" already exists.`;
      }
      return undefined;
    },
  });
  return name?.trim() || undefined;
}

/** Creates a new profile (asking name + commandName) and opens it for editing. Returns its name. */
export async function addProfile(project: TargetProject): Promise<string | undefined> {
  const settings = await readLaunchSettings(project.rootDir);
  const name = await promptProfileName(settings, { title: "New launch profile — name" });
  if (!name) {
    return undefined;
  }
  const commandName = await vscode.window.showQuickPick(COMMAND_NAMES, {
    title: `New launch profile "${name}" — command`,
    placeHolder: "How should this profile launch?",
  });
  if (!commandName) {
    return undefined;
  }

  const { order, profiles } = snapshot(settings);
  order.push(name);
  profiles[name] = {
    commandName,
    launchBrowser: false,
    dotnetRunMessages: false,
    environmentVariables: {},
  };
  await persist(project, { order, profiles });
  await editProfile(project, name);
  return name;
}

/** Duplicates a profile (unknown keys and all) under a new name, then opens the copy for editing. */
export async function duplicateProfile(project: TargetProject, sourceName: string): Promise<void> {
  const settings = await readLaunchSettings(project.rootDir);
  const source = findProfile(settings, sourceName);
  if (!source) {
    return;
  }
  const newName = await promptProfileName(settings, {
    title: `Duplicate "${source.name}" — new name`,
    value: `${source.name} - Copy`,
  });
  if (!newName) {
    return;
  }

  const { order, profiles } = snapshot(settings);
  order.push(newName);
  profiles[newName] = toEditable(source);
  // Seeding the copy from the source's raw object preserves its unknown keys too.
  await persist(project, { order, profiles, renames: { [newName]: source.name } });
  await editProfile(project, newName);
}

/** Deletes a profile after confirmation, clearing the pin if it was pointing at that profile. */
export async function deleteProfile(project: TargetProject, name: string): Promise<void> {
  const settings = await readLaunchSettings(project.rootDir);
  const profile = findProfile(settings, name);
  if (!profile) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete launch profile "${profile.name}"?`,
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") {
    return;
  }

  const { order, profiles } = snapshot(settings);
  const remaining = order.filter((n) => n !== profile.name);
  delete profiles[profile.name];
  await persist(project, { order: remaining, profiles });

  if (getActiveProfileName(project.uri.fsPath) === profile.name) {
    setActiveProfileName(project.uri.fsPath, undefined);
  }
}

interface FieldItem extends vscode.QuickPickItem {
  action?: FieldAction;
}

type FieldAction =
  | "address"
  | "openBrowser"
  | "environment"
  | "arguments"
  | "command"
  | "advanced"
  | "rename";

const ASPNETCORE_ENVIRONMENT = "ASPNETCORE_ENVIRONMENT";
const COMMON_ENVIRONMENTS = ["Development", "Staging", "Production"];
const SEPARATOR: FieldItem = { label: "", kind: vscode.QuickPickItemKind.Separator };

/** A project is "web" when its SDK is web/razor/blazor, or the profile already looks web-shaped. */
async function isWebProfile(project: TargetProject, profile: LaunchProfile): Promise<boolean> {
  if (profile.applicationUrl !== undefined || profile.launchUrl !== undefined) {
    return true;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(project.uri);
    return isWebSdk(parseSdkAttribute(new TextDecoder().decode(bytes)));
  } catch {
    return false;
  }
}

/** The curated main list: guided common fields up front, the rarely-touched ones behind Advanced. */
function fieldItems(profile: LaunchProfile, isWeb: boolean): FieldItem[] {
  const isProject = profile.commandName.toLowerCase() === "project";
  const envValue = profile.environmentVariables[ASPNETCORE_ENVIRONMENT];
  const items: FieldItem[] = [];

  if (isProject && isWeb) {
    const { scheme } = parseApplicationUrl(profile.applicationUrl);
    items.push(
      { action: "address", label: "Address", description: schemeLabel(scheme) },
      { action: "openBrowser", label: "Open browser", description: profile.launchBrowser ? "Yes" : "No" },
      { action: "environment", label: "Environment", description: envValue ?? "(default)" },
      { action: "arguments", label: "Arguments", description: profile.commandLineArgs ?? "" },
    );
  } else if (isProject) {
    items.push(
      { action: "arguments", label: "Arguments", description: profile.commandLineArgs ?? "" },
      { action: "environment", label: "Environment", description: envValue ?? "(default)" },
    );
  } else {
    items.push({ action: "command", label: "Command", description: profile.commandName });
  }

  items.push(
    SEPARATOR,
    { action: "advanced", label: "$(gear) Advanced..." },
    { action: "rename", label: "$(pencil) Rename profile" },
  );
  return items;
}

function schemeLabel(scheme: UrlScheme): string {
  return scheme === "both" ? "HTTPS + HTTP" : scheme === "https" ? "HTTPS only" : "HTTP only";
}

/** Guided editor for one profile: pick a field, change it, write immediately, stay open. */
export async function editProfile(project: TargetProject, initialName: string): Promise<void> {
  let name = initialName;

  while (true) {
    const settings = await readLaunchSettings(project.rootDir);
    const profile = findProfile(settings, name);
    if (!profile) {
      return; // deleted or renamed out from under us
    }
    name = profile.name;
    const isWeb = await isWebProfile(project, profile);

    const pick = await vscode.window.showQuickPick(fieldItems(profile, isWeb), {
      title: `Edit profile: ${name}`,
      placeHolder: "Pick something to change (Esc when done)",
    });
    if (!pick?.action) {
      return;
    }

    const next = await applyFieldEdit(project, settings, profile, pick.action);
    if (next) {
      name = next;
    }
  }
}

async function applyFieldEdit(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  profile: LaunchProfile,
  action: FieldAction,
): Promise<string | undefined> {
  switch (action) {
    case "address":
      await editAddress(project, settings, profile);
      return undefined;
    case "openBrowser":
      await writeFieldChange(project, settings, profile.name, (f) => (f.launchBrowser = !f.launchBrowser));
      return undefined;
    case "environment":
      await editEnvironment(project, profile.name);
      return undefined;
    case "arguments":
      await editStringField(project, settings, profile, "commandLineArgs", "Arguments");
      return undefined;
    case "command":
      await editCommand(project, settings, profile);
      return undefined;
    case "advanced":
      await editAdvanced(project, profile.name);
      return undefined;
    case "rename":
      return editRename(project, settings, profile);
  }
}

async function editRename(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  profile: LaunchProfile,
): Promise<string | undefined> {
  const newName = await promptProfileName(settings, {
    title: `Rename "${profile.name}"`,
    value: profile.name,
    except: profile.name,
  });
  if (!newName || newName === profile.name) {
    return undefined;
  }
  await writeFieldChange(project, settings, profile.name, () => {}, newName);
  if (getActiveProfileName(project.uri.fsPath) === profile.name) {
    setActiveProfileName(project.uri.fsPath, newName);
  }
  return newName;
}

async function editCommand(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  profile: LaunchProfile,
): Promise<void> {
  const commandName = await vscode.window.showQuickPick(COMMAND_NAMES, { title: `Command for "${profile.name}"` });
  if (!commandName) {
    return;
  }
  await writeFieldChange(project, settings, profile.name, (f) => (f.commandName = commandName));
}

/** Guided address picker: choose a scheme, then the port(s), rather than hand-typing applicationUrl. */
async function editAddress(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  profile: LaunchProfile,
): Promise<void> {
  const current = parseApplicationUrl(profile.applicationUrl);
  const choice = await vscode.window.showQuickPick(
    [
      { label: "HTTPS + HTTP", description: "recommended", scheme: "both" as UrlScheme },
      { label: "HTTPS only", scheme: "https" as UrlScheme },
      { label: "HTTP only", scheme: "http" as UrlScheme },
      { label: "$(edit) Custom...", description: "type the applicationUrl yourself", scheme: undefined },
    ],
    { title: `Address for "${profile.name}"` },
  );
  if (!choice) {
    return;
  }

  if (choice.scheme === undefined) {
    await editStringField(project, settings, profile, "applicationUrl", "Application URL");
    return;
  }

  const ports: UrlPorts = {};
  if (choice.scheme === "both" || choice.scheme === "https") {
    const port = await askPort("HTTPS port", current.ports.httpsPort ?? DEFAULT_HTTPS_PORT);
    if (port === undefined) {
      return;
    }
    ports.httpsPort = port;
  }
  if (choice.scheme === "both" || choice.scheme === "http") {
    const port = await askPort("HTTP port", current.ports.httpPort ?? DEFAULT_HTTP_PORT);
    if (port === undefined) {
      return;
    }
    ports.httpPort = port;
  }

  const applicationUrl = buildApplicationUrl(choice.scheme, ports);
  await writeFieldChange(project, settings, profile.name, (f) => (f.applicationUrl = applicationUrl));
}

async function askPort(title: string, value: number): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: String(value),
    validateInput: (raw) => (/^\d{1,5}$/.test(raw.trim()) && Number(raw) <= 65535 ? undefined : "Enter a port (1–65535)."),
  });
  return input === undefined ? undefined : Number(input.trim());
}

/** Guided environment picker for the common ASPNETCORE_ENVIRONMENT values. */
async function editEnvironment(project: TargetProject, profileName: string): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      ...COMMON_ENVIRONMENTS.map((label) => ({ label, custom: false, clear: false })),
      { label: "$(edit) Custom...", custom: true, clear: false },
      { label: "$(clear-all) Clear", custom: false, clear: true },
    ],
    { title: `Environment for "${profileName}" (${ASPNETCORE_ENVIRONMENT})` },
  );
  if (!choice) {
    return;
  }

  if (choice.clear) {
    await setEnvVar(project, profileName, ASPNETCORE_ENVIRONMENT, undefined);
    return;
  }

  let value = choice.label;
  if (choice.custom) {
    const input = await vscode.window.showInputBox({ title: `${ASPNETCORE_ENVIRONMENT} value` });
    if (input === undefined || input.trim().length === 0) {
      return;
    }
    value = input.trim();
  }
  await setEnvVar(project, profileName, ASPNETCORE_ENVIRONMENT, value);
}

interface AdvancedItem extends vscode.QuickPickItem {
  field?: "workingDirectory" | "launchUrl" | "executablePath" | "applicationUrl";
  toggle?: "dotnetRunMessages";
  env?: boolean;
}

/** The rarely-touched fields, kept out of the main list behind "Advanced...". */
async function editAdvanced(project: TargetProject, profileName: string): Promise<void> {
  while (true) {
    const settings = await readLaunchSettings(project.rootDir);
    const profile = findProfile(settings, profileName);
    if (!profile) {
      return;
    }
    const items: AdvancedItem[] = [
      { field: "workingDirectory", label: "Working directory", description: profile.workingDirectory ?? "" },
      { field: "launchUrl", label: "Launch URL", description: profile.launchUrl ?? "" },
      { field: "executablePath", label: "Executable path", description: profile.executablePath ?? "" },
      { field: "applicationUrl", label: "Application URL (raw)", description: profile.applicationUrl ?? "" },
      {
        toggle: "dotnetRunMessages",
        label: `${profile.dotnetRunMessages ? "$(check)" : "$(dash)"} dotnet run messages`,
        description: profile.dotnetRunMessages ? "on" : "off",
      },
      {
        env: true,
        label: "Environment variables",
        description: `${Object.keys(profile.environmentVariables).length} $(chevron-right)`,
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Advanced — ${profileName}`,
      placeHolder: "Esc to go back",
    });
    if (!pick) {
      return;
    }

    if (pick.env) {
      await editEnvironmentVariables(project, profileName);
    } else if (pick.toggle) {
      await writeFieldChange(project, settings, profileName, (f) => (f.dotnetRunMessages = !f.dotnetRunMessages));
    } else if (pick.field) {
      const label = pick.label.replace(" (raw)", "");
      await editStringField(project, settings, profile, pick.field, label);
    }
  }
}

/** Optional-string field editor shared by the guided and advanced flows; empty clears the key. */
async function editStringField(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  profile: LaunchProfile,
  field: "commandLineArgs" | "workingDirectory" | "launchUrl" | "executablePath" | "applicationUrl",
  label: string,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: `${label} for "${profile.name}"`,
    value: profile[field],
    placeHolder: "Leave empty to remove",
  });
  if (input === undefined) {
    return;
  }
  const value = input.trim().length > 0 ? input : undefined;
  await writeFieldChange(project, settings, profile.name, (f) => {
    (f as unknown as Record<string, string | undefined>)[field] = value;
  });
}

/**
 * Rebuilds the full snapshot from `settings`, applies `mutate` to the one target profile (and an
 * optional rename), and writes the file. Untouched profiles round-trip through the writer unchanged.
 */
async function writeFieldChange(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  targetName: string,
  mutate: (fields: EditableProfileFields) => void,
  renameTo?: string,
): Promise<void> {
  const order: string[] = [];
  const profiles: Record<string, EditableProfileFields> = {};
  const renames: Record<string, string> = {};

  for (const profile of settings.profiles) {
    const finalName = profile.name === targetName && renameTo ? renameTo : profile.name;
    const fields = toEditable(profile);
    if (profile.name === targetName) {
      mutate(fields);
    }
    order.push(finalName);
    profiles[finalName] = fields;
    if (finalName !== profile.name) {
      renames[finalName] = profile.name;
    }
  }

  await persist(project, {
    order,
    profiles,
    renames: Object.keys(renames).length > 0 ? renames : undefined,
  });
}

interface EnvItem extends vscode.QuickPickItem {
  key?: string;
  add?: boolean;
}

/** Sub-editor for a profile's environment variables: rows with a trash button, plus "Add variable". */
async function editEnvironmentVariables(project: TargetProject, profileName: string): Promise<void> {
  const removeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("trash"),
    tooltip: "Remove variable",
  };

  const qp = vscode.window.createQuickPick<EnvItem>();
  qp.title = `Environment variables — ${profileName}`;
  qp.placeholder = "Pick a variable to edit, or add one (Esc when done)";

  const load = async (): Promise<LaunchProfile | undefined> => {
    const settings = await readLaunchSettings(project.rootDir);
    const profile = findProfile(settings, profileName);
    if (!profile) {
      qp.hide();
      return undefined;
    }
    const rows: EnvItem[] = Object.entries(profile.environmentVariables).map(([key, value]) => ({
      label: key,
      description: value,
      key,
      buttons: [removeButton],
    }));
    qp.items = [...rows, { label: "$(add) Add variable", add: true }];
    return profile;
  };

  return new Promise<void>((resolve) => {
    const done = (): void => {
      qp.dispose();
      resolve();
    };

    qp.onDidTriggerItemButton(async (event) => {
      const key = event.item.key;
      if (key) {
        await setEnvVar(project, profileName, key, undefined);
        await load();
      }
    });

    qp.onDidAccept(async () => {
      const [item] = qp.selectedItems;
      if (!item) {
        return;
      }
      qp.hide();
      if (item.add) {
        await promptAddEnvVar(project, profileName);
      } else if (item.key) {
        await promptEditEnvVar(project, profileName, item.key);
      }
      const profile = await load();
      if (profile) {
        qp.show();
      }
    });

    qp.onDidHide(done);

    void load().then(() => qp.show());
  });
}

async function promptAddEnvVar(project: TargetProject, profileName: string): Promise<void> {
  const key = await vscode.window.showInputBox({ title: "New variable — name", placeHolder: "e.g. ASPNETCORE_ENVIRONMENT" });
  if (!key || key.trim().length === 0) {
    return;
  }
  const value = await vscode.window.showInputBox({ title: `Value for ${key.trim()}` });
  if (value === undefined) {
    return;
  }
  await setEnvVar(project, profileName, key.trim(), value);
}

async function promptEditEnvVar(project: TargetProject, profileName: string, key: string): Promise<void> {
  const settings = await readLaunchSettings(project.rootDir);
  const current = findProfile(settings, profileName)?.environmentVariables[key];
  const value = await vscode.window.showInputBox({ title: `Value for ${key}`, value: current });
  if (value === undefined) {
    return;
  }
  await setEnvVar(project, profileName, key, value);
}

/** Sets (value given) or removes (value undefined) one environment variable and writes the file. */
async function setEnvVar(
  project: TargetProject,
  profileName: string,
  key: string,
  value: string | undefined,
): Promise<void> {
  const settings = await readLaunchSettings(project.rootDir);
  await writeFieldChange(project, settings, profileName, (fields) => {
    if (value === undefined) {
      delete fields.environmentVariables[key];
    } else {
      fields.environmentVariables[key] = value;
    }
  });
}
