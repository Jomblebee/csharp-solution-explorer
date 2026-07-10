// Pure construction of the server launch command (no `vscode`/IO, so it is unit-testable). The
// Roslyn server speaks LSP over stdio; native builds (Windows .exe / Linux apphost) are launched
// directly, while the DLL build is launched via `dotnet exec` (macOS/neutral). Args follow the
// reference implementations: `--logLevel=<level> --extensionLogDirectory <dir> --stdio`.

import { ResolvedServer } from "./roslynDownloader.js";

export interface ServerLaunch {
  command: string;
  args: string[];
  /** For display in the status UI. */
  launch: "native" | "dotnet";
}

export function buildServerLaunch(
  server: Pick<ResolvedServer, "entryPath" | "kind">,
  logLevel: string,
  logDir: string,
): ServerLaunch {
  const serverArgs = [`--logLevel=${logLevel}`, "--extensionLogDirectory", logDir, "--stdio"];
  if (server.kind === "dll") {
    return { command: "dotnet", args: ["exec", server.entryPath, ...serverArgs], launch: "dotnet" };
  }
  return { command: server.entryPath, args: serverArgs, launch: "native" };
}

/**
 * Classifies a user-supplied `languageServer.serverPath` into how it must be launched: a `.dll` is
 * run via `dotnet exec`, anything else (a native apphost, with or without `.exe`) is run directly.
 */
export function localServerKind(serverPath: string): "exe" | "dll" {
  return serverPath.toLowerCase().endsWith(".dll") ? "dll" : "exe";
}
