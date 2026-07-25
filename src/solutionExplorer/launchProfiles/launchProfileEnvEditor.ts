// The environment-variable side of the launch profile editor: the guided
// `ASPNETCORE_ENVIRONMENT` picker shown in the main list, and the full variables sub-editor behind
// "Advanced...". Kept apart from the other field editors because it is the only flow that manages a
// live `createQuickPick` (rows need per-item buttons) instead of a one-shot dialog.

import * as vscode from "vscode";
import { ASPNETCORE_ENVIRONMENT, findProfile, LaunchProfile } from "../parsers/launchSettingsReader.js";
import { readLaunchSettings, writeFieldChange } from "./launchSettingsIo.js";
import { TargetProject } from "../workspaceProjects.js";

const COMMON_ENVIRONMENTS = ["Development", "Staging", "Production"];

/** Guided environment picker for the common ASPNETCORE_ENVIRONMENT values. */
export async function editEnvironment(project: TargetProject, profileName: string): Promise<void> {
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

interface EnvItem extends vscode.QuickPickItem {
  key?: string;
  add?: boolean;
}

/** Sub-editor for a profile's environment variables: rows with a trash button, plus "Add variable". */
export async function editEnvironmentVariables(project: TargetProject, profileName: string): Promise<void> {
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
