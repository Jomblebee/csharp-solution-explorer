// The launch-profile half of the Project Properties panel.
//
// It adds no edit logic of its own: the pure builders in launchProfiles/launchProfileEdits.ts and the
// round-tripping writer in parsers/launchSettingsWriter.ts already decide what a change means, and
// launchSettingsIo.ts already owns the file. This module only translates the panel's messages into
// those calls, so the panel and the existing QuickPick editor stay in agreement about the file — and so
// the tested code stays the only code that writes it.

import * as vscode from "vscode";
import {
  ASPNETCORE_ENVIRONMENT,
  type LaunchProfile,
  type ParsedLaunchSettings,
} from "../parsers/launchSettingsReader.js";
import type { EditableProfileFields } from "../parsers/launchSettingsWriter.js";
import {
  buildAddEdit,
  buildDeleteEdit,
  buildDuplicateEdit,
  nameExists,
} from "../launchProfiles/launchProfileEdits.js";
import { persist, readLaunchSettings, writeFieldChange } from "../launchProfiles/launchSettingsIo.js";
import { projectFromUri, type TargetProject } from "../workspaceProjects.js";

/** Fields the panel edits as plain text or a switch. */
export type ProfileTextField =
  | "commandName"
  | "commandLineArgs"
  | "workingDirectory"
  | "applicationUrl"
  | "launchUrl"
  | "executablePath";

export type ProfileFlagField = "launchBrowser" | "dotnetRunMessages";

/** A profile as the webview sees it — the parsed shape, which is already plain data. */
export type ProfileView = LaunchProfile;

export class LaunchProfileEditor {
  private readonly project: TargetProject;

  constructor(projectUri: vscode.Uri) {
    this.project = projectFromUri(projectUri);
  }

  async read(): Promise<ProfileView[]> {
    const settings = await readLaunchSettings(this.project.rootDir);
    return settings.profiles;
  }

  async add(name: string, commandName: string): Promise<void> {
    const settings = await this.settings();
    const trimmed = name.trim();
    if (trimmed === "") {
      throw new Error("A profile needs a name.");
    }
    if (nameExists(settings, trimmed)) {
      throw new Error(`A profile named "${trimmed}" already exists.`);
    }
    await persist(this.project, buildAddEdit(settings, trimmed, commandName || "Project"));
  }

  async duplicate(sourceName: string, newName: string): Promise<void> {
    const settings = await this.settings();
    const source = findProfile(settings, sourceName);
    const trimmed = newName.trim();
    if (nameExists(settings, trimmed)) {
      throw new Error(`A profile named "${trimmed}" already exists.`);
    }
    await persist(this.project, buildDuplicateEdit(settings, source, trimmed));
  }

  async delete(name: string): Promise<void> {
    const settings = await this.settings();
    findProfile(settings, name);
    await persist(this.project, buildDeleteEdit(settings, name));
  }

  async rename(name: string, newName: string): Promise<void> {
    const settings = await this.settings();
    findProfile(settings, name);
    const trimmed = newName.trim();
    if (trimmed === "") {
      throw new Error("A profile needs a name.");
    }
    if (nameExists(settings, trimmed, name)) {
      throw new Error(`A profile named "${trimmed}" already exists.`);
    }
    await writeFieldChange(this.project, settings, name, () => undefined, trimmed);
  }

  /** Writes one text field. An empty value clears the key, matching the QuickPick editor. */
  async setTextField(name: string, field: ProfileTextField, value: string): Promise<void> {
    const settings = await this.settings();
    findProfile(settings, name);
    await writeFieldChange(this.project, settings, name, (fields) => {
      assignText(fields, field, value);
    });
  }

  async setFlag(name: string, field: ProfileFlagField, value: boolean): Promise<void> {
    const settings = await this.settings();
    findProfile(settings, name);
    await writeFieldChange(this.project, settings, name, (fields) => {
      fields[field] = value;
    });
  }

  /**
   * Replaces a profile's environment variables wholesale. The panel edits them as a block, and the
   * writer drops the key entirely when the block is empty.
   */
  async setEnvironment(name: string, environment: Record<string, string>): Promise<void> {
    const settings = await this.settings();
    findProfile(settings, name);
    await writeFieldChange(this.project, settings, name, (fields) => {
      fields.environmentVariables = { ...environment };
    });
  }

  /** The ASP.NET Core environment name, surfaced separately because it is the one people change most. */
  async setAspNetEnvironment(name: string, value: string): Promise<void> {
    const settings = await this.settings();
    const profile = findProfile(settings, name);
    const environment = { ...profile.environmentVariables };
    if (value.trim() === "") {
      delete environment[ASPNETCORE_ENVIRONMENT];
    } else {
      environment[ASPNETCORE_ENVIRONMENT] = value.trim();
    }
    await this.setEnvironment(name, environment);
  }

  private async settings(): Promise<ParsedLaunchSettings> {
    // Re-read on every operation: the QuickPick editor writes the same file, and the builders need a
    // full snapshot of the current state so untouched profiles round-trip.
    return readLaunchSettings(this.project.rootDir);
  }
}

function findProfile(settings: ParsedLaunchSettings, name: string): LaunchProfile {
  const wanted = name.toLowerCase();
  const profile = settings.profiles.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!profile) {
    throw new Error(`The profile "${name}" no longer exists.`);
  }
  return profile;
}

function assignText(fields: EditableProfileFields, field: ProfileTextField, value: string): void {
  const trimmed = value.trim();
  if (field === "commandName") {
    // commandName is required — an empty one would make the profile unrunnable.
    fields.commandName = trimmed === "" ? fields.commandName : trimmed;
    return;
  }
  fields[field] = trimmed === "" ? undefined : trimmed;
}
