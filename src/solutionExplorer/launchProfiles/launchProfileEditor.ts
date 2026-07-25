// Editing launch profiles through built-in VS Code dialogs (QuickPick + InputBox) — no webview. The
// profile picker (launchProfileCommands) opens these flows via its per-item pencil/copy/trash
// buttons and a "New profile…" entry. Every change is written to launchSettings.json immediately via
// the pure, round-tripping `launchSettingsWriter`, so unknown keys the reader does not model survive.
//
// This file owns the profile lifecycle (create/duplicate/delete/rename) and the menus; the dialogs
// for individual fields live in `launchProfileFieldEditors.ts` and `launchProfileEnvEditor.ts`, the
// edit arithmetic in `launchProfileEdits.ts`, and the fs access in `launchSettingsIo.ts`.

import * as vscode from "vscode";
import {
  ASPNETCORE_ENVIRONMENT,
  LaunchProfile,
  ParsedLaunchSettings,
  findProfile,
} from "../parsers/launchSettingsReader.js";
import { persist, readLaunchSettings, writeFieldChange } from "./launchSettingsIo.js";
import { buildAddEdit, buildDeleteEdit, buildDuplicateEdit, nameExists } from "./launchProfileEdits.js";
import { getActiveProfileName, setActiveProfileName } from "./launchProfileState.js";
import { TargetProject } from "../workspaceProjects.js";
import { isWebSdk, parseSdkAttribute } from "../parsers/csprojReader.js";
import { parseApplicationUrl } from "./launchProfileUrls.js";
import {
  COMMAND_NAMES,
  editAddress,
  editCommand,
  editStringField,
  schemeLabel,
} from "./launchProfileFieldEditors.js";
import { editEnvironment, editEnvironmentVariables } from "./launchProfileEnvEditor.js";

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

  await persist(project, buildAddEdit(settings, name, commandName));
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

  await persist(project, buildDuplicateEdit(settings, source, newName));
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

  await persist(project, buildDeleteEdit(settings, profile.name));

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
