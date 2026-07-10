// Wires the vscode-languageclient to the Roslyn server: builds the client, performs the
// non-standard "open workspace" handshake, and handles the server's request to restore projects so
// external (NuGet) references resolve. The file discovery reuses the same globs the tree uses.

import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { restore } from "../solutionExplorer/dotnetCli.js";
import { ResolvedServer } from "./roslynDownloader.js";
import { decideHandshake } from "./roslynHandshake.js";
import { buildServerLaunch } from "./roslynServer.js";
import { ServerStateStore } from "./serverState.js";

const EXCLUDE_GLOB = "**/{node_modules,bin,obj,.git,.vs}/**";

export function createLanguageClient(
  server: ResolvedServer,
  logLevel: string,
  logDir: string,
  outputChannel: vscode.OutputChannel,
): LanguageClient {
  const launch = buildServerLaunch(server, logLevel, logDir);
  const executable = { command: launch.command, args: launch.args };
  const serverOptions: ServerOptions = { run: executable, debug: executable };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "csharp" }],
    outputChannel,
    progressOnInitialization: true,
  };
  return new LanguageClient(
    "csharpSolutionExplorer.languageServer",
    "C# Language Server",
    serverOptions,
    clientOptions,
  );
}

/**
 * Registers handlers for the Roslyn-specific server→client messages. Call once, after the client
 * has started. Method names are specific to the pinned server version; if a name changes the
 * handler simply never fires, which degrades gracefully rather than breaking the session.
 */
export function registerRoslynProtocol(client: LanguageClient, state: ServerStateStore): void {
  client.onNotification("workspace/projectInitializationComplete", () => {
    state.update({ phase: "running", activity: undefined });
  });

  // Roslyn asks the client to restore projects it can't resolve, so hover/diagnostics work for
  // external libraries. We reuse the existing `dotnet restore` wrapper. Params carry the project
  // file paths (as paths or file: URIs).
  client.onRequest(
    "workspace/_roslyn_projectNeedsRestore",
    async (params: { projectFilePaths?: string[] }) => {
      const paths = params?.projectFilePaths ?? [];
      state.update({ activity: "Restoring packages…" });
      for (const p of paths) {
        try {
          await restore(toFsPath(p));
        } catch {
          // Best-effort: a failed restore must not break the language session.
        }
      }
      state.update({ activity: undefined });
      return null;
    },
  );
}

/**
 * The non-standard open handshake: discover a solution (or loose projects) and tell the server to
 * load it. Roslyn provides no diagnostics/IntelliSense until this is sent.
 */
export async function performHandshake(client: LanguageClient, state: ServerStateStore): Promise<void> {
  const solutions = await findFiles(["**/*.sln", "**/*.slnx"]);
  const projects = solutions.length > 0 ? [] : await findFiles(["**/*.csproj"]);
  const action = decideHandshake(solutions, projects);

  if (action.kind === "solution") {
    state.update({ solution: action.solution, projects: undefined, activity: "Loading solution…" });
    await client.sendNotification("solution/open", { solution: toUri(action.solution) });
  } else if (action.kind === "projects") {
    state.update({ projects: action.projects, solution: undefined, activity: "Loading projects…" });
    await client.sendNotification("project/open", { projects: action.projects.map(toUri) });
  } else {
    // Nothing to open — clear the "initializing" activity so the status doesn't hang.
    state.update({ solution: undefined, projects: undefined, activity: undefined });
  }
}

/** Finds files for the given globs across workspace folders, shallowest path first. */
async function findFiles(globs: string[]): Promise<string[]> {
  const uris: vscode.Uri[] = [];
  for (const glob of globs) {
    uris.push(...(await vscode.workspace.findFiles(glob, EXCLUDE_GLOB)));
  }
  return uris
    .map((u) => u.fsPath)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

const depth = (p: string): number => p.split(/[\\/]/).length;
const toUri = (fsPath: string): string => vscode.Uri.file(fsPath).toString();
const toFsPath = (p: string): string => (p.startsWith("file:") ? vscode.Uri.parse(p).fsPath : p);
