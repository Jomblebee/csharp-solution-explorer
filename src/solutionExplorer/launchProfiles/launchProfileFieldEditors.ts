// The per-field dialogs the launch profile editor dispatches to: address (scheme + ports), the
// optional-string fields, and the `commandName` picker. Each one asks, writes immediately, and
// returns — the menu that decides *which* of them runs lives in `launchProfileEditor.ts`.

import * as vscode from "vscode";
import { LaunchProfile, ParsedLaunchSettings } from "../parsers/launchSettingsReader.js";
import { writeFieldChange } from "./launchSettingsIo.js";
import { TargetProject } from "../workspaceProjects.js";
import {
  buildApplicationUrl,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parseApplicationUrl,
  UrlPorts,
  UrlScheme,
} from "./launchProfileUrls.js";

/** The `commandName`s worth offering; `Project` is the one that actually runs the project itself. */
export const COMMAND_NAMES = ["Project", "Executable", "IISExpress"];

export function schemeLabel(scheme: UrlScheme): string {
  return scheme === "both" ? "HTTPS + HTTP" : scheme === "https" ? "HTTPS only" : "HTTP only";
}

export async function editCommand(
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
export async function editAddress(
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

/** Optional-string field editor shared by the guided and advanced flows; empty clears the key. */
export async function editStringField(
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
