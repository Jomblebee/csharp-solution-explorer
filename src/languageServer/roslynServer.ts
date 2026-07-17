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

/**
 * The Razor cohost input for the Roslyn process (Stufe 2). When present, Roslyn handles
 * `.razor`/`.cshtml` itself and there is no second language server.
 *
 * IMPORTANT: we deliberately do **not** pass the Razor extension via `--extension`. On the built-in-Razor
 * server (`5.10`+), the server auto-loads its bundled Razor extension from its own directory; passing it
 * again explicitly loads the Razor source generator into a *second* assembly load context, so the Razor
 * out-of-process service can't match the generator run result and every `.razor`/`.cshtml` request fails
 * with "the Razor source generator is not referenced …" for SDK Razor/Blazor projects (verified: dropping
 * `--extension` fixes it; roslyn.nvim likewise launches with no `--extension` and Razor works). The only
 * flag we pass is `--csharpDesignTimePath`, the design-time targets polyfill Razor needs for *non-SDK*
 * Razor projects outside C# Dev Kit (harmless for SDK projects). It ships inside the server package
 * (see `razorLaunchPaths`).
 */
export interface RazorLaunch {
  /** Path passed via `--csharpDesignTimePath` (the design-time targets polyfill outside C# Dev Kit). */
  csharpDesignTimePath: string;
}

export function buildServerLaunch(
  server: Pick<ResolvedServer, "entryPath" | "kind">,
  logLevel: string,
  logDir: string,
  razor?: RazorLaunch,
): ServerLaunch {
  const serverArgs = [`--logLevel=${logLevel}`, "--extensionLogDirectory", logDir];
  if (razor) {
    // No `--extension`: the built-in-Razor server auto-loads its Razor extension; passing it here breaks
    // the Razor source-generator wiring (see the RazorLaunch doc above).
    serverArgs.push("--csharpDesignTimePath", razor.csharpDesignTimePath);
  }
  serverArgs.push("--stdio");
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
