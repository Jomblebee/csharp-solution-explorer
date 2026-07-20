import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrappers around the `dotnet` CLI for NuGet package management. Going through the CLI (rather
 * than editing the .csproj directly) means NuGet resolves the version and runs a restore, so the
 * Dependencies tree — which reads obj/project.assets.json — reflects the change immediately,
 * including the pulled-in transitive packages. Mirrors the existing `dotnet build`/`dotnet run`.
 */
async function runDotnet(args: string[]): Promise<void> {
  try {
    await execFileAsync("dotnet", args, { windowsHide: true });
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      throw new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to manage packages.");
    }
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

export interface BuildResult {
  ok: boolean;
  /** Combined stdout+stderr, so compiler diagnostics can be shown to the user verbatim. */
  output: string;
}

/**
 * Builds a project and waits for the result. Unlike the tree's Build command (which fires into the
 * integrated terminal and cannot be awaited), the debugger has to know whether the build succeeded
 * before it launches anything.
 *
 * Deliberately does not throw on a non-zero exit: a compile error is an expected outcome, not an
 * exceptional one, so the caller decides how to present it.
 */
export async function build(
  targetFsPath: string,
  opts: { framework?: string; configuration?: string } = {},
): Promise<BuildResult> {
  const args = ["build", targetFsPath, "-c", opts.configuration ?? "Debug"];
  if (opts.framework) {
    args.push("-f", opts.framework);
  }
  try {
    // A solution-wide build easily exceeds execFile's 1 MB default buffer.
    const { stdout, stderr } = await execFileAsync("dotnet", args, {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      throw new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to build and debug.");
    }
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    const output = `${stdout}${stderr}`.trim();
    return { ok: false, output: output || (err instanceof Error ? err.message : String(err)) };
  }
}

/** Installs (or, for an already-referenced package, changes the version of) a NuGet package. */
export function addPackage(projectFsPath: string, id: string, version?: string): Promise<void> {
  const args = ["add", projectFsPath, "package", id];
  if (version) {
    args.push("--version", version);
  }
  return runDotnet(args);
}

export function removePackage(projectFsPath: string, id: string): Promise<void> {
  return runDotnet(["remove", projectFsPath, "package", id]);
}

/**
 * Lists the version strings of the installed .NET SDKs via `dotnet --list-sdks`, whose lines look
 * like `9.0.100 [/usr/local/share/dotnet/sdk]`. Returns an empty array when the `dotnet` CLI is not
 * on PATH (ENOENT), so callers can treat "no SDK installed" and "CLI missing" the same way.
 */
export async function listInstalledSdks(): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("dotnet", ["--list-sdks"], { windowsHide: true }));
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((version) => /^\d+\.\d+\.\d+/.test(version));
}

/** Scaffolds a new project from a `dotnet new` template into `outputDir` (created if missing). */
export function newProject(template: string, name: string, outputDir: string): Promise<void> {
  return runDotnet(["new", template, "-n", name, "-o", outputDir]);
}

/**
 * Runs a restore so obj/project.assets.json reflects the current references. `dotnet add package`
 * restores on its own, but `dotnet remove package` does not — without this the removed package
 * would linger in the Dependencies tree until the next build.
 */
export function restore(projectFsPath: string): Promise<void> {
  return runDotnet(["restore", projectFsPath]);
}
