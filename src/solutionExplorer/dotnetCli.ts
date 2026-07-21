import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Reporter } from "../shared/httpDownload.js";
import { computeProgress, countProjectGraph, createBuildProgressState, parseBuildLine } from "./buildProgress.js";

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
 * exceptional one, so the caller decides how to present it. Streams stdout/stderr (rather than
 * `execFile`'s buffer-then-return) so `opts.onProgress` can report live progress as MSBuild output
 * arrives — see `parseBuildLine`/`computeProgress` for the parsing/weighting logic.
 */
export async function build(
  targetFsPath: string,
  opts: { framework?: string; configuration?: string; onProgress?: Reporter } = {},
): Promise<BuildResult> {
  const args = ["build", targetFsPath, "-c", opts.configuration ?? "Debug"];
  if (opts.framework) {
    args.push("-f", opts.framework);
  }

  const totalProjects = await countProjectGraph(targetFsPath);
  const state = createBuildProgressState(totalProjects);
  opts.onProgress?.("Building…", 0);

  return new Promise<BuildResult>((resolve, reject) => {
    const child = spawn("dotnet", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stdoutRest = "";

    const feedStdout = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const combined = stdoutRest + chunk.toString("utf8");
      const lines = combined.split("\n");
      stdoutRest = lines.pop() ?? "";
      for (const rawLine of lines) {
        const event = parseBuildLine(rawLine.replace(/\r$/, ""));
        if (event) {
          const progress = computeProgress(state, event);
          opts.onProgress?.(progress.message, progress.fraction);
        }
      }
    };

    child.stdout.on("data", feedStdout);
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to build and debug."));
        return;
      }
      resolve({ ok: false, output: output.trim() || err.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output });
    });
  });
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
