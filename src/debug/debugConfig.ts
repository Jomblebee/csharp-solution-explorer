// Merges what MSBuild says a project produces with the selected launchSettings.json profile into
// the body netcoredbg expects. Pure, so the precedence rules stay unit-testable.

import { ResolvedLaunchProfile } from "../solutionExplorer/launchSettingsReader.js";
import { resolveWorkingDirectory } from "../solutionExplorer/launchSettingsReader.js";
import { ProjectOutput } from "./projectOutput.js";

/** The debug type we contribute. Not `coreclr`/`clr`/`dotnet` — those belong to the MS C# extension. */
export const DEBUG_TYPE = "csharp-netcoredbg";

export interface NetcoredbgLaunchConfig {
  type: string;
  request: "launch";
  name: string;
  /** Verified against netcoredbg 3.2.0: this must be the `.dll`, not the apphost. */
  program: string;
  args: string[];
  cwd: string;
  /** Verified: netcoredbg takes an object map here, not an array of {name, value}. */
  env: Record<string, string>;
  stopAtEntry: boolean;
  console: "internalConsole" | "integratedTerminal";
}

export interface NetcoredbgAttachConfig {
  type: string;
  request: "attach";
  name: string;
  processId: number;
  /** For PDB/symbol resolution — netcoredbg's `attach` accepts this alongside `processId`. */
  program: string;
}

/** No precedence merging here — `buildLaunchConfig` already resolves `program` for the caller. */
export function buildAttachConfig(name: string, program: string, processId: number): NetcoredbgAttachConfig {
  return { type: DEBUG_TYPE, request: "attach", name, processId, program };
}

export interface NetcoredbgExternalAttachConfig {
  type: string;
  /**
   * Disguised as `launch` on purpose: VS Code's debug toolbar defaults an `attach` session's Stop
   * button to "Disconnect" (leave the process running, tucking real Stop behind a dropdown) — correct
   * for attaching to something you don't own, wrong here, since we spawned this process ourselves.
   * `netcoredbgProxy.ts`'s `rewriteOutgoing` rewrites the wire-level `launch` request into a real
   * `attach` before netcoredbg ever sees it, and rewrites the response back for VS Code.
   */
  request: "launch";
  name: string;
  processId: number;
  program: string;
}

/** Only for `startDebuggingInExternalTerminal` — see `NetcoredbgExternalAttachConfig`'s doc comment. */
export function buildExternalAttachConfig(name: string, program: string, processId: number): NetcoredbgExternalAttachConfig {
  return { type: DEBUG_TYPE, request: "launch", name, processId, program };
}

export interface BuildLaunchConfigInput {
  name: string;
  output: ProjectOutput;
  profile?: ResolvedLaunchProfile;
  projectRootDir: string;
  stopAtEntry?: boolean;
  console?: "internalConsole" | "integratedTerminal";
  /** Values written explicitly in a launch.json, which outrank everything else. */
  overrides?: { args?: string[]; cwd?: string; env?: Record<string, string>; program?: string };
}

/**
 * Precedence, most specific first: explicit launch.json values, then the launch profile, then what
 * MSBuild reports. `profile.env` already carries `ASPNETCORE_URLS` folded in from `applicationUrl`
 * (see `resolveLaunchProfile`), so it must not be derived again here.
 */
export function buildLaunchConfig(input: BuildLaunchConfigInput): NetcoredbgLaunchConfig {
  const { name, output, profile, projectRootDir, overrides } = input;

  const cwd =
    overrides?.cwd ??
    (profile?.workingDirectory !== undefined
      ? resolveWorkingDirectory(profile.workingDirectory, projectRootDir)
      : output.workingDirectory);

  const args = overrides?.args ?? (profile && profile.args.length > 0 ? profile.args : output.args);

  return {
    type: DEBUG_TYPE,
    request: "launch",
    name,
    program: overrides?.program ?? output.program,
    args,
    cwd,
    env: { ...(profile?.env ?? {}), ...(overrides?.env ?? {}) },
    stopAtEntry: input.stopAtEntry ?? false,
    // netcoredbg 3.2.0 ignores this field: it always launches the program itself and reports its
    // stdout/stderr as DAP `output` events, which VS Code shows in the Debug Console. We keep the
    // field (a newer adapter may honour it) but visibility is handled via `internalConsoleOptions`
    // in the configuration provider, which reveals that Debug Console on launch.
    console: input.console ?? "internalConsole",
  };
}
