// Reading and writing a project's `Properties/launchSettings.json`. The only place in the launch
// profile code that touches the file system, so the parsing (`launchSettingsReader`), the edit
// arithmetic (`launchProfileEdits`) and the writing (`launchSettingsWriter`) all stay pure and
// unit-testable around it.

import * as vscode from "vscode";
import {
  getLaunchSettingsPath,
  ParsedLaunchSettings,
  parseLaunchSettings,
} from "../parsers/launchSettingsReader.js";
import {
  applyLaunchSettingsEdit,
  EditableProfileFields,
  LaunchSettingsEdit,
} from "../parsers/launchSettingsWriter.js";
import { buildFieldChange } from "./launchProfileEdits.js";
import { TargetProject } from "../workspaceProjects.js";

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
 * The raw text of a project's launchSettings.json, needed by the editor so its writes round-trip
 * against the exact on-disk content (preserving keys we do not model). A missing file returns "",
 * which the writer scaffolds into a fresh file.
 */
export async function readLaunchSettingsRaw(projectRootDir: vscode.Uri): Promise<string> {
  const uri = vscode.Uri.file(getLaunchSettingsPath(projectRootDir.fsPath));
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return "";
  }
}

/** Persists new launchSettings.json text. `writeFile` creates the `Properties/` directory as needed. */
export async function writeLaunchSettings(projectRootDir: vscode.Uri, text: string): Promise<void> {
  const uri = vscode.Uri.file(getLaunchSettingsPath(projectRootDir.fsPath));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** Applies an edit against the file's current raw text, so unknown keys survive the write. */
export async function persist(project: TargetProject, edit: LaunchSettingsEdit): Promise<void> {
  const raw = await readLaunchSettingsRaw(project.rootDir);
  await writeLaunchSettings(project.rootDir, applyLaunchSettingsEdit(raw, edit));
}

/** Mutates one profile's fields (optionally renaming it) and writes the file. */
export async function writeFieldChange(
  project: TargetProject,
  settings: ParsedLaunchSettings,
  targetName: string,
  mutate: (fields: EditableProfileFields) => void,
  renameTo?: string,
): Promise<void> {
  await persist(project, buildFieldChange(settings, targetName, mutate, renameTo));
}
