// Drives the "Debug Startup Project in External Terminal" command: build, resolve the launch
// profile, spawn the program in a real OS terminal (see attachTerminal.ts), then have netcoredbg
// `attach` to it instead of `launch`-ing and owning it — the only way to get real console I/O while
// debugging, since netcoredbg always funnels a launched program's output into the Debug Console.
//
// Deliberately bypasses NetcoredbgConfigurationProvider's resolve hooks (which are launch-shaped
// throughout) and drives the same MSBuild/profile resolution steps directly instead. The provider
// still passes an `attach`-request config straight through unresolved — see its pass-through guard.

import * as vscode from "vscode";
import { CANCELLED, resolveRunFramework } from "../solutionExplorer/commandUtils.js";
import { build } from "../solutionExplorer/dotnetCli.js";
import { makeReporter } from "../shared/httpDownload.js";
import {
  findWorkspaceProjects,
  projectFromUri,
  promptForStartupProject,
  resolveActiveProfile,
  TargetProject,
} from "../solutionExplorer/launchProfileCommands.js";
import { getStartupProjectFsPath } from "../solutionExplorer/launchProfileState.js";
import { spawnForAttach } from "./attachTerminal.js";
import { buildExternalAttachConfig, buildLaunchConfig } from "./debugConfig.js";
import { CONFIG_SECTION, readExternalTerminalAttachDelayMs } from "./debugSettings.js";
import { DebuggerStateStore } from "./debugState.js";
import { AmbiguousFrameworkError, queryProjectOutput } from "./projectOutput.js";

export async function startDebuggingInExternalTerminal(
  state: DebuggerStateStore,
  output: vscode.OutputChannel,
): Promise<void> {
  const project = await resolveStartupProject();
  if (!project) {
    return;
  }

  const framework = await resolveRunFramework(project.uri, project.name);
  if (framework === CANCELLED) {
    return;
  }

  // Short status lines, replayed into the session's own Debug Console once it exists (see
  // netcoredbgProxy.ts's `preSessionLog` handling) — everything here happens before any debug
  // session/adapter does, so there is nowhere else to show it live. Full build output stays in the
  // "C# Debugger" output channel only: too long/noisy for the Debug Console.
  const log: string[] = [];
  const note = (line: string): void => {
    log.push(line);
    output.appendLine(line);
  };

  const configuration = "Debug";
  try {
    if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("buildBeforeLaunch", true)) {
      state.set({ phase: "building", activity: `Building ${project.name}…` });
      note(`Building ${project.name}…`);
      // Only the mid-build stage transitions are noted here — the "Building X…"/"Build succeeded."
      // bookends are already covered by the note() calls right before/after this withProgress call.
      let lastNotedStage: string | undefined;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building ${project.name}…`, cancellable: false },
        (progress) => {
          const report = makeReporter(progress);
          return build(project.uri.fsPath, {
            framework,
            configuration,
            onProgress: (message, fraction) => {
              report(message, fraction);
              if (message === undefined) {
                return;
              }
              state.update({ activity: message });
              const isStageMarker = message === "Restoring…" || message.startsWith("Compiling…");
              if (isStageMarker && message !== lastNotedStage) {
                lastNotedStage = message;
                note(message);
              }
            },
          });
        },
      );
      output.appendLine(result.output);
      if (!result.ok) {
        state.set({ phase: "failed", detail: "The build failed." });
        const choice = await vscode.window.showErrorMessage(
          `Build failed for ${project.name}. Debugging was not started.`,
          "Show Output",
        );
        if (choice === "Show Output") {
          output.show(true);
        }
        return;
      }
      note("Build succeeded.");
    }

    state.update({ phase: "debugging", activity: `Resolving ${project.name}…` });
    const projectOutput = await queryProjectOutput(project.uri.fsPath, framework, configuration);
    const profile = await resolveActiveProfile(project);
    const launch = buildLaunchConfig({
      name: `C#: ${project.name}`,
      output: projectOutput,
      profile,
      projectRootDir: project.rootDir.fsPath,
    });

    state.update({ activity: `Starting ${project.name} in an external terminal…` });
    note(`Starting ${project.name} in an external terminal…`);
    const pid = await spawnForAttach({
      cwd: launch.cwd,
      program: launch.program,
      args: launch.args,
      env: launch.env,
      startupDelayMs: readExternalTerminalAttachDelayMs() || undefined,
    });

    note(`Attaching to pid ${pid} (${launch.program}).`);
    state.update({ activity: `Attaching to pid ${pid}…` });
    const started = await vscode.debug.startDebugging(folderFor(project), {
      ...buildExternalAttachConfig(`C#: ${project.name} (external terminal)`, launch.program, pid),
      internalConsoleOptions: "openOnSessionStart",
      // Read by netcoredbgAdapter.ts to rewrite the disguised `launch` into a real `attach`, to make
      // Stop terminate the process instead of just detaching, and to replay `log` into the session's
      // Debug Console — see buildExternalAttachConfig's doc comment for why the request is disguised.
      ownsExternalProcess: true,
      preSessionLog: log,
    });
    if (!started) {
      state.set({ phase: "failed", detail: "netcoredbg could not attach to the external process." });
    }
  } catch (err) {
    const message = err instanceof AmbiguousFrameworkError ? err.message : errorText(err);
    state.set({ phase: "failed", detail: message });
    vscode.window.showErrorMessage(`C# Solution Explorer: ${message}`);
  }
}

async function resolveStartupProject(): Promise<TargetProject | undefined> {
  const startup = getStartupProjectFsPath();
  if (startup) {
    return projectFromUri(vscode.Uri.file(startup));
  }
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No C# project was found in this workspace, so there is nothing to debug.");
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }
  return promptForStartupProject();
}

/** The session's folder — decides `${workspaceFolder}` substitution and multi-root attribution. */
function folderFor(project: TargetProject): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(project.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
