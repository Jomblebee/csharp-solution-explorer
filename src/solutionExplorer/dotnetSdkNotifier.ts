import * as vscode from "vscode";
import { parseTargetFrameworks } from "./parsers/csprojReader.js";
import {
  evaluateSdk,
  formatWarning,
  GlobalJsonSdk,
  parseGlobalJsonSdk,
} from "./dotnetSdkCheck.js";
import { listInstalledSdks } from "./dotnetCli.js";

// The canonical, open-source download page for the .NET SDK (MIT / .NET Foundation). Linking here
// keeps the OSS-only constraint intact — no proprietary dependency is introduced.
const DOWNLOAD_URL = "https://dotnet.microsoft.com/download";
const DOWNLOAD_ACTION = "Download .NET SDK";

const PROJECT_GLOB = "**/*.{csproj,fsproj,vbproj}";
const GLOBAL_JSON_GLOB = "**/global.json";
const EXCLUDE_GLOB = "**/{node_modules,bin,obj,.git,.vs}/**";

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function collectTfms(): Promise<string[]> {
  const projectUris = await vscode.workspace.findFiles(PROJECT_GLOB, EXCLUDE_GLOB);
  const tfms: string[] = [];
  for (const uri of projectUris) {
    const text = await readText(uri);
    if (text) {
      tfms.push(...parseTargetFrameworks(text));
    }
  }
  return tfms;
}

async function findGlobalJson(): Promise<GlobalJsonSdk | undefined> {
  const uris = (await vscode.workspace.findFiles(GLOBAL_JSON_GLOB, EXCLUDE_GLOB)).sort((a, b) =>
    a.fsPath.localeCompare(b.fsPath),
  );
  for (const uri of uris) {
    const text = await readText(uri);
    const pin = text ? parseGlobalJsonSdk(text) : undefined;
    if (pin) {
      return pin;
    }
  }
  return undefined;
}

/**
 * Runs once on activation (best-effort, never throws): checks whether an SDK matching what the open
 * solution needs is installed, and if not shows a warning offering the official download page. Runs
 * on every start by design — there is no "don't show again".
 */
export async function checkDotnetSdk(): Promise<void> {
  try {
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      return;
    }
    const [installedVersions, globalJson, tfms] = await Promise.all([
      listInstalledSdks(),
      findGlobalJson(),
      collectTfms(),
    ]);

    const message = formatWarning(evaluateSdk({ installedVersions, globalJson, tfms }));
    if (!message) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(message, DOWNLOAD_ACTION);
    if (choice === DOWNLOAD_ACTION) {
      await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
    }
  } catch {
    // The SDK check is a best-effort nudge; any failure must not disrupt activation.
  }
}
