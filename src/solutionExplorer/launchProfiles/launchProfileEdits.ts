// The edit arithmetic behind the launch profile editor: turning a parsed launchSettings.json plus one
// intended change into a `LaunchSettingsEdit` for `launchSettingsWriter`. Pure — no vscode, no fs — so
// the rules that decide *what* gets written stay separate from the dialogs that ask the user and the
// fs calls that persist the answer (`launchSettingsIo.ts`).
//
// Every builder starts from a full snapshot of all profiles rather than a partial patch, because the
// writer round-trips: profiles nobody touched still have to appear in the edit to survive unchanged.

import { LaunchProfile, ParsedLaunchSettings } from "../parsers/launchSettingsReader.js";
import { EditableProfileFields, LaunchSettingsEdit } from "../parsers/launchSettingsWriter.js";

export function toEditable(profile: LaunchProfile): EditableProfileFields {
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
export function snapshot(settings: ParsedLaunchSettings): {
  order: string[];
  profiles: Record<string, EditableProfileFields>;
} {
  const order: string[] = [];
  const profiles: Record<string, EditableProfileFields> = {};
  for (const profile of settings.profiles) {
    order.push(profile.name);
    profiles[profile.name] = toEditable(profile);
  }
  return { order, profiles };
}

/** Case-insensitive, matching `findProfile`; `except` lets a profile keep its own name on rename. */
export function nameExists(settings: ParsedLaunchSettings, name: string, except?: string): boolean {
  const wanted = name.toLowerCase();
  return settings.profiles.some((p) => p.name.toLowerCase() === wanted && p.name.toLowerCase() !== except?.toLowerCase());
}

/** A new profile appended at the end, with the defaults a freshly created profile carries. */
export function buildAddEdit(settings: ParsedLaunchSettings, name: string, commandName: string): LaunchSettingsEdit {
  const { order, profiles } = snapshot(settings);
  order.push(name);
  profiles[name] = {
    commandName,
    launchBrowser: false,
    dotnetRunMessages: false,
    environmentVariables: {},
  };
  return { order, profiles };
}

/** A copy of `source` under `newName`; the rename entry seeds it from the source's raw object, so the copy keeps the source's unknown keys too. */
export function buildDuplicateEdit(
  settings: ParsedLaunchSettings,
  source: LaunchProfile,
  newName: string,
): LaunchSettingsEdit {
  const { order, profiles } = snapshot(settings);
  order.push(newName);
  profiles[newName] = toEditable(source);
  return { order, profiles, renames: { [newName]: source.name } };
}

export function buildDeleteEdit(settings: ParsedLaunchSettings, name: string): LaunchSettingsEdit {
  const { order, profiles } = snapshot(settings);
  const remaining = order.filter((n) => n !== name);
  delete profiles[name];
  return { order: remaining, profiles };
}

/**
 * Rebuilds the full snapshot from `settings` and applies `mutate` to the one target profile (and an
 * optional rename). Untouched profiles round-trip through the writer unchanged.
 */
export function buildFieldChange(
  settings: ParsedLaunchSettings,
  targetName: string,
  mutate: (fields: EditableProfileFields) => void,
  renameTo?: string,
): LaunchSettingsEdit {
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

  return {
    order,
    profiles,
    renames: Object.keys(renames).length > 0 ? renames : undefined,
  };
}
