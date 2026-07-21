// Turns "press F5 with nothing configured" into a real launch: pick the startup project, apply its
// launchSettings.json profile, build, ask MSBuild what was produced, and hand netcoredbg the result.

import * as path from "node:path";
import * as vscode from "vscode";
import { CANCELLED, resolveRunFramework } from "../solutionExplorer/commandUtils.js";
import { build } from "../solutionExplorer/dotnetCli.js";
import {
  findWorkspaceProjects,
  projectFromUri,
  promptForStartupProject,
  resolveActiveProfile,
  TargetProject,
} from "../solutionExplorer/launchProfileCommands.js";
import { getStartupProjectFsPath } from "../solutionExplorer/launchProfileState.js";
import { makeReporter } from "../shared/httpDownload.js";
import { buildLaunchConfig, DEBUG_TYPE, NetcoredbgLaunchConfig } from "./debugConfig.js";
import { CONFIG_SECTION, shouldOfferConfigurations } from "./debugSettings.js";
import { DebuggerStateStore } from "./debugState.js";
import { AmbiguousFrameworkError, queryProjectOutput } from "./projectOutput.js";

/** The subset of a `launch.json` entry we read before filling the rest in. */
interface PartialConfig extends vscode.DebugConfiguration {
  project?: string;
  launchProfile?: string;
  noLaunchProfile?: boolean;
  targetFramework?: string;
  configuration?: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopAtEntry?: boolean;
  console?: "internalConsole" | "integratedTerminal";
  internalConsoleOptions?: "neverOpen" | "openOnFirstSessionStart" | "openOnSessionStart";
  build?: boolean;
  /** Set by startDebuggingInExternalTerminal()'s disguised-as-launch attach config — see its guard below. */
  ownsExternalProcess?: boolean;
}

/**
 * True for a config this provider must not touch: a hand-authored `attach` (real attach semantics,
 * e.g. attaching to some other already-running process) or our own external-terminal flow's
 * disguised-as-launch attach (already fully resolved by `startDebuggingInExternalTerminal` — this
 * provider only knows how to resolve `launch`).
 */
function isPreResolved(config: vscode.DebugConfiguration): boolean {
  return config.request === "attach" || (config as PartialConfig).ownsExternalProcess === true;
}

export class NetcoredbgConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly state: DebuggerStateStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Seeds a newly created launch.json. VS Code writes *every* entry returned here into the file, so
   * this deliberately returns a single project-less entry rather than one per project: `resolveProject`
   * picks the startup project at launch time, which keeps the file short, portable (no absolute paths)
   * and stable when the startup project changes. Mirrors `initialConfigurations` in package.json.
   *
   * The searchable per-project list belongs to `provideDynamicConfigurations` — keep the two apart.
   */
  async provideDebugConfigurations(): Promise<vscode.DebugConfiguration[]> {
    if (!this.shouldOfferConfigurations()) {
      return [];
    }
    return [{ type: DEBUG_TYPE, request: "launch", name: "C#: Debug startup project" }];
  }

  /**
   * Populates the Run and Debug dropdown and the F5 picker without a launch.json — picking one of
   * these starts a session directly and writes nothing to disk, so listing every project is fine
   * here. Whether we appear alongside the Microsoft C# extension is the user's call via
   * `debug.offerConfigurations`.
   */
  async provideDynamicConfigurations(): Promise<vscode.DebugConfiguration[]> {
    if (!this.shouldOfferConfigurations()) {
      return [];
    }
    const projects = await findWorkspaceProjects();
    if (projects.length === 0) {
      return [];
    }
    const startup = getStartupProjectFsPath();
    // Startup project first: it is what F5 will use by default.
    const ordered = [...projects].sort((a, b) => Number(b.uri.fsPath === startup) - Number(a.uri.fsPath === startup));
    return ordered.map((project) => ({
      type: DEBUG_TYPE,
      request: "launch",
      name: project.uri.fsPath === startup ? `C#: ${project.name} (startup project)` : `C#: ${project.name}`,
      project: project.uri.fsPath,
    }));
  }

  /**
   * Runs before variable substitution, so this stage only chooses *what* to debug — the parts that
   * may need to prompt. Anything touching resolved paths waits for the second hook.
   *
   * Returning `null` makes VS Code open/create a launch.json; `undefined` aborts silently. We use
   * `null` only when there is genuinely nothing to debug.
   */
  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    if (isPreResolved(config)) {
      return config;
    }
    const partial = config as PartialConfig;
    this.output.appendLine(
      `F5 / debug requested (type='${config.type || "(none)"}', project='${partial.project ?? "(startup)"}').`,
    );

    const project = await this.resolveProject(partial);
    if (project === null) {
      this.abort("No C# project was found in this workspace, so there is nothing to debug.");
      return null;
    }
    if (!project) {
      this.output.appendLine("Debug start cancelled: no startup project was selected.");
      return undefined;
    }

    const framework = partial.targetFramework ?? (await resolveRunFramework(project.uri, project.name));
    if (framework === CANCELLED) {
      this.output.appendLine("Debug start cancelled: no target framework was selected.");
      return undefined;
    }

    return {
      ...partial,
      type: DEBUG_TYPE,
      request: "launch",
      name: partial.name || `C#: ${project.name}`,
      project: project.uri.fsPath,
      targetFramework: framework,
    };
  }

  /**
   * Runs after `${workspaceFolder}` and friends are substituted, so a user-supplied `cwd`/`program`
   * is already a real path. The build and the MSBuild query belong here — and in this order, since
   * querying `TargetPath` before building can hand back a stale or missing assembly.
   */
  async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (isPreResolved(config)) {
      return config;
    }
    const partial = config as PartialConfig;
    if (!partial.project) {
      this.abort(
        "Debugging could not start: no project was resolved. Press F5 with a C# file focused, or set a startup project.",
      );
      return undefined;
    }
    const project = projectFromUri(vscode.Uri.file(partial.project));
    const configuration = partial.configuration ?? "Debug";

    try {
      if (partial.build !== false && this.buildBeforeLaunch()) {
        const ok = await this.buildProject(project, partial.targetFramework, configuration);
        if (!ok) {
          return undefined;
        }
      }

      this.state.update({ phase: "debugging", activity: `Resolving ${project.name}…` });
      const output = await queryProjectOutput(project.uri.fsPath, partial.targetFramework, configuration);
      const profile = await resolveActiveProfile(project, {
        noLaunchProfile: partial.noLaunchProfile,
        launchProfile: partial.launchProfile,
      });

      const launch: NetcoredbgLaunchConfig = buildLaunchConfig({
        name: partial.name,
        output,
        profile,
        projectRootDir: project.rootDir.fsPath,
        stopAtEntry: partial.stopAtEntry,
        console: partial.console,
        overrides: {
          args: partial.args,
          cwd: partial.cwd,
          env: partial.env,
          program: partial.program,
        },
      });
      this.output.appendLine(`Launching ${launch.program} (cwd ${launch.cwd})`);
      // Spread `partial` first so VS Code's own launch.json fields survive — `serverReadyAction`
      // (open the browser when Kestrel logs "Now listening on…"), `presentation`, `sourceFileMap`,
      // etc. `launch` then wins for the resolved netcoredbg body (program/args/cwd/env), so our
      // MSBuild/profile resolution takes precedence over any raw user values.
      // netcoredbg reports the program's stdout/stderr as DAP output events, which land in the Debug
      // Console — so reveal it on launch (overridable per launch.json, e.g. "neverOpen").
      const resolved: vscode.DebugConfiguration = {
        ...partial,
        ...launch,
        internalConsoleOptions: partial.internalConsoleOptions ?? "openOnSessionStart",
      };

      // "launch browser" comes from the profile alone (Visual Studio's model). netcoredbg has no
      // browser support, so we open it via VS Code's serverReadyAction — unless launch.json sets one.
      if ((profile?.launchBrowser ?? false) && resolved.serverReadyAction === undefined) {
        resolved.serverReadyAction = browserServerReadyAction(profile?.launchUrl);
      }
      return resolved;
    } catch (err) {
      const message = err instanceof AmbiguousFrameworkError ? err.message : errorText(err);
      this.state.set({ phase: "failed", detail: message });
      this.abort(`Failed to start debugging: ${message}`);
      vscode.window.showErrorMessage(`C# Solution Explorer: ${message}`);
      return undefined;
    }
  }

  /**
   * Logs why a debug start was aborted and reveals the "C# Debugger" output channel (without
   * stealing focus), so a session that ends before the adapter even starts is never silent.
   */
  private abort(reason: string): void {
    this.output.appendLine(reason);
    this.output.show(true);
  }

  private async buildProject(project: TargetProject, framework: string | undefined, configuration: string): Promise<boolean> {
    this.state.set({ phase: "building", activity: `Building ${project.name}…` });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Building ${project.name}…`, cancellable: false },
      (progress) => {
        const report = makeReporter(progress);
        return build(project.uri.fsPath, {
          framework,
          configuration,
          onProgress: (message, fraction) => {
            report(message, fraction);
            if (message !== undefined) {
              this.state.update({ activity: message });
            }
          },
        });
      },
    );
    this.output.appendLine(result.output);
    if (!result.ok) {
      this.state.set({ phase: "failed", detail: "The build failed." });
      const choice = await vscode.window.showErrorMessage(
        `Build failed for ${project.name}. Debugging was not started.`,
        "Show Output",
      );
      if (choice === "Show Output") {
        this.output.show(true);
      }
    }
    return result.ok;
  }

  /** `null` = nothing to debug at all, `undefined` = the user cancelled a prompt. */
  private async resolveProject(partial: PartialConfig): Promise<TargetProject | undefined | null> {
    if (partial.project) {
      return projectFromUri(vscode.Uri.file(partial.project));
    }
    const startup = getStartupProjectFsPath();
    if (startup) {
      return projectFromUri(vscode.Uri.file(startup));
    }
    const projects = await findWorkspaceProjects();
    if (projects.length === 0) {
      return null;
    }
    if (projects.length === 1) {
      return projects[0];
    }
    return (await promptForStartupProject()) ?? undefined;
  }

  private buildBeforeLaunch(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("buildBeforeLaunch", true);
  }

  private shouldOfferConfigurations(): boolean {
    return shouldOfferConfigurations();
  }
}

/**
 * Writes a launch.json whose first entry is ours. VS Code always runs the first configuration on
 * F5, so this is the only way to pin the choice when another C# debugger is also installed.
 */
export async function setAsDefaultDebugger(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showInformationMessage("Open a folder before setting the default debugger.");
    return;
  }
  const startup = getStartupProjectFsPath();
  const project = startup ? projectFromUri(vscode.Uri.file(startup)) : await promptForStartupProject();
  if (!project) {
    return;
  }

  const launchConfig = vscode.workspace.getConfiguration("launch", folder.uri);
  const existing = launchConfig.get<vscode.DebugConfiguration[]>("configurations") ?? [];
  const entry: vscode.DebugConfiguration = {
    name: `C#: Debug ${project.name}`,
    type: DEBUG_TYPE,
    request: "launch",
    project: project.uri.fsPath,
  };
  // Drop any earlier entry of ours for the same project so repeated invocations don't stack up.
  const rest = existing.filter((c) => !(c.type === DEBUG_TYPE && c.project === project.uri.fsPath));
  await launchConfig.update("configurations", [entry, ...rest], vscode.ConfigurationTarget.WorkspaceFolder);
  vscode.window.showInformationMessage(`F5 now debugs ${project.name} with the C# Solution Explorer debugger.`);
}

/**
 * A `serverReadyAction` that opens the browser once Kestrel logs its URL. netcoredbg emits that line
 * as a DAP output event, which is what VS Code watches. A relative `launchUrl` (e.g. "swagger") is
 * appended to the reported URL via `uriFormat`; an absolute or empty one opens the reported URL.
 */
function browserServerReadyAction(launchUrl: string | undefined): Record<string, string> {
  const action: Record<string, string> = {
    action: "openExternally",
    pattern: "\\bNow listening on:\\s+(https?://\\S+)",
  };
  if (launchUrl && !/^https?:\/\//i.test(launchUrl)) {
    action.uriFormat = `%s/${launchUrl.replace(/^\/+/, "")}`;
  }
  return action;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Relative label used in messages, e.g. "src/App/App.csproj". */
export function projectLabel(project: TargetProject): string {
  return path.basename(project.uri.fsPath);
}
