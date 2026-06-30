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
