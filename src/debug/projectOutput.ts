// Resolves which assembly to launch for a project by asking MSBuild, rather than guessing from the
// csproj. MSBuild is the source of truth: `AssemblyName`/`OutputPath` are routinely set in a
// `Directory.Build.props` the csproj reader never sees, may sit in a conditional `<PropertyGroup>`,
// and .NET 8's `UseArtifactsOutput` relocates the output tree entirely. These are the same
// properties `dotnet run` consumes, so Run and Debug agree by construction.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseCommandLineArgs } from "../solutionExplorer/parsers/launchSettingsReader.js";

const execFileAsync = promisify(execFile);

/** A solution-wide build easily exceeds execFile's 1 MB default. */
const MAX_BUFFER = 32 * 1024 * 1024;

export interface ProjectOutput {
  /** The assembly to hand the debugger as `program` — netcoredbg wants the `.dll`, not the apphost. */
  program: string;
  args: string[];
  workingDirectory: string;
  outputType: string;
  targetFramework: string;
}

/** Raised when a multi-targeted project was queried without naming a framework. */
export class AmbiguousFrameworkError extends Error {
  constructor() {
    super("This project targets multiple frameworks. Select which one to debug.");
    this.name = "AmbiguousFrameworkError";
  }
}

/**
 * Parses the payload of `dotnet msbuild -getProperty:...`. MSBuild emits a bare string when a
 * single property is requested and a `{"Properties": {...}}` object for several, so both shapes are
 * accepted; `singleName` names the property for the bare-string case. Returns `undefined` for
 * anything unparseable, so callers can fall back rather than crash.
 */
export function parseGetPropertyOutput(stdout: string, singleName?: string): Record<string, string> | undefined {
  const text = stdout.trim();
  if (text === "") {
    return undefined;
  }
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { Properties?: unknown };
      const props = parsed?.Properties;
      if (!props || typeof props !== "object" || Array.isArray(props)) {
        return undefined;
      }
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    } catch {
      return undefined;
    }
  }
  // Bare single-property form. Without a name to bind it to there is nothing usable here.
  return singleName ? { [singleName]: text } : undefined;
}

/**
 * Asks MSBuild what a project produces. `framework` is required for multi-targeted projects —
 * without it MSBuild returns an *empty* `TargetPath` rather than failing, which would otherwise
 * surface as a mystifying "assembly not found" much later.
 */
export async function queryProjectOutput(
  projectFsPath: string,
  framework?: string,
  configuration = "Debug",
): Promise<ProjectOutput> {
  const args = [
    "msbuild",
    projectFsPath,
    "-getProperty:TargetPath",
    "-getProperty:RunArguments",
    "-getProperty:RunWorkingDirectory",
    "-getProperty:OutputType",
    "-getProperty:TargetFramework",
    `-p:Configuration=${configuration}`,
    "-v:q",
    "--nologo",
  ];
  if (framework) {
    args.push(`-p:TargetFramework=${framework}`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("dotnet", args, { windowsHide: true, maxBuffer: MAX_BUFFER }));
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      throw new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to debug.");
    }
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }

  const props = parseGetPropertyOutput(stdout);
  if (!props) {
    throw new Error(`Could not read the build output path for ${path.basename(projectFsPath)}.`);
  }

  const program = props.TargetPath?.trim() ?? "";
  if (program === "") {
    // The signature of a multi-targeted project queried without a framework.
    throw new AmbiguousFrameworkError();
  }

  return {
    program,
    args: parseCommandLineArgs(props.RunArguments),
    // RunWorkingDirectory is commonly empty; the project directory is what `dotnet run` uses then.
    workingDirectory: props.RunWorkingDirectory?.trim() || path.dirname(projectFsPath),
    outputType: props.OutputType?.trim() ?? "",
    targetFramework: props.TargetFramework?.trim() ?? framework ?? "",
  };
}
