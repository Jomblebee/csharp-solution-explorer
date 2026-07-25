// Makes F5 start the startup project directly, with no launch.json and no debugger picker.
//
// VS Code has no API for "this extension owns F5", so we contribute our own `f5` keybinding gated on
// a context key. The keybinding's `when` mirrors VS Code's own default rule
// (`debugState == 'inactive'`) rather than `!inDebugMode`: during `initializing` — which is long here,
// because we build and query MSBuild first — `inDebugMode` is not reliably set, so a second F5 press
// would start a duplicate session. `stopped` keeps F5 bound to Continue, as it should be.
//
// The same two commands also sit as icons in the editor title bar (see `contributes.menus` →
// `editor/title`), for the mouse route.

import * as vscode from "vscode";
import { runProjectInExternalTerminal } from "../solutionExplorer/commands/buildCommands.js";
import { findWorkspaceProjects } from "../solutionExplorer/workspaceProjects.js";
import { getStartupProjectFsPath } from "../solutionExplorer/launchProfiles/launchProfileState.js";
import { DEBUG_TYPE } from "./debugConfig.js";
import { CONFIG_SECTION, isMsCsharpInstalled, readF5ConsoleMode, readOfferConfigurationsMode } from "./debugSettings.js";
import { computeOwnsF5 } from "./f5Policy.js";

const CONTEXT_KEY = "csharpSolutionExplorer.debug.ownsF5";
/** Gates the editor-title buttons — see `registerF5Ownership`. */
const AVAILABLE_KEY = "csharpSolutionExplorer.debug.available";
const START_COMMAND = "csharpSolutionExplorer.debug.start";
const START_WITHOUT_DEBUGGING_COMMAND = "csharpSolutionExplorer.debug.startWithoutDebugging";

/**
 * Registered *before* `activateDebugger`'s `enabled` check returns, so the commands exist in the
 * palette either way — they fall back to VS Code's own actions when the debugger is off.
 */
export function registerF5Ownership(
  context: vscode.ExtensionContext,
  options: { debuggerEnabled: boolean; startInTerminal: (host: "external" | "integrated") => Promise<void> },
): void {
  const refresh = (): void => {
    const owns = computeOwnsF5({
      handleF5: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("handleF5", true),
      debuggerEnabledAtActivation: options.debuggerEnabled,
      offerMode: readOfferConfigurationsMode(),
      msCsharpInstalled: isMsCsharpInstalled(),
      hasLaunchConfigurations: hasLaunchConfigurations(),
      overrideLaunchJson: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("ignoreLaunchJson", true),
    });
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, owns);
  };

  // Seed immediately: the keybinding is evaluated the moment the window has focus, and an unset
  // context key reads as false — which would hand the first F5 press back to the picker.
  refresh();

  // Static for the window's lifetime, and deliberately *not* `ownsF5`: the editor-title buttons keep
  // working once a launch.json exists (an explicit click is not a hijacked keypress). Menu items are
  // rendered from package.json before the extension activates, so gating them on a context key is
  // what keeps the two icons out of a workspace that has no C# in it at all.
  void vscode.commands.executeCommand("setContext", AVAILABLE_KEY, options.debuggerEnabled);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A launch.json edit surfaces as a change to the `launch` section — no file watcher needed.
      if (event.affectsConfiguration("launch") || event.affectsConfiguration(CONFIG_SECTION)) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    // Installing or removing the Microsoft C# extension flips ownership without a window reload.
    vscode.extensions.onDidChange(refresh),
    vscode.commands.registerCommand(START_COMMAND, () =>
      startDebugging(options.debuggerEnabled, options.startInTerminal),
    ),
    vscode.commands.registerCommand(START_WITHOUT_DEBUGGING_COMMAND, () => startWithoutDebugging()),
  );
}

/**
 * Starts a session from an *inline* configuration — nothing is written to disk. The configuration
 * providers then do the real work: pick the project and framework, build, read launchSettings.json.
 *
 * When `debug.f5Console` is `externalTerminal` or `integratedTerminal`, this defers to the same
 * spawn-then-attach flow as the "Debug Startup Project in External Terminal" command instead (hosted
 * in an OS window or a VS Code integrated terminal respectively) — see `externalTerminalDebug.ts` for
 * why `launch` alone cannot show a real, interactive console.
 */
async function startDebugging(
  debuggerEnabled: boolean,
  startInTerminal: (host: "external" | "integrated") => Promise<void>,
): Promise<void> {
  const startup = getStartupProjectFsPath();
  if (!debuggerEnabled || !(await hasSomethingToDebug(startup))) {
    await vscode.commands.executeCommand("workbench.action.debug.start");
    return;
  }
  const consoleMode = readF5ConsoleMode();
  if (consoleMode === "externalTerminal") {
    await startInTerminal("external");
    return;
  }
  if (consoleMode === "integratedTerminal") {
    await startInTerminal("integrated");
    return;
  }
  await vscode.debug.startDebugging(folderFor(startup), {
    type: DEBUG_TYPE,
    request: "launch",
    name: "C#: Debug startup project",
  });
}

/**
 * Ctrl+F5, Visual-Studio-style. Runs via `dotnet run` in a real OS terminal instead of passing
 * `noDebug` to netcoredbg, which would still funnel the program's output into the Debug Console.
 */
async function startWithoutDebugging(): Promise<void> {
  if (!(await hasSomethingToDebug(getStartupProjectFsPath()))) {
    await vscode.commands.executeCommand("workbench.action.debug.run");
    return;
  }
  await runProjectInExternalTerminal();
}

/**
 * Guards the fallback to VS Code's own F5, so a workspace without C# behaves exactly as it would
 * without this extension. The workspace-wide glob runs only when no startup project is set, not on
 * every keypress — and its result is not cached, since projects come and go.
 */
async function hasSomethingToDebug(startup: string | undefined): Promise<boolean> {
  return startup !== undefined || (await findWorkspaceProjects()).length > 0;
}

/**
 * The session's folder. Neither resolve hook reads it, but it decides `${workspaceFolder}`
 * substitution and how the session is attributed in a multi-root workspace.
 */
function folderFor(startup: string | undefined): vscode.WorkspaceFolder | undefined {
  const owning = startup ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(startup)) : undefined;
  return owning ?? vscode.workspace.workspaceFolders?.[0];
}

/**
 * Whether the workspace defines launch configurations of its own — in a launch.json or a
 * .code-workspace. Only workspace scopes count: `get()` would fold in the user's global settings,
 * which would disable the takeover everywhere for anyone who keeps configurations there.
 *
 * Multi-root has no per-folder answer (context keys are global), so any folder having configurations
 * makes us stand aside for the whole window.
 */
function hasLaunchConfigurations(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  const scopes: (vscode.Uri | undefined)[] = folders?.length ? folders.map((f) => f.uri) : [undefined];
  return scopes.some((uri) => {
    const inspected = vscode.workspace.getConfiguration("launch", uri).inspect<unknown[]>("configurations");
    return (inspected?.workspaceValue?.length ?? 0) > 0 || (inspected?.workspaceFolderValue?.length ?? 0) > 0;
  });
}
