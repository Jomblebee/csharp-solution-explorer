// Orchestrates the C# language server lifecycle: decides whether to run (setting + auto-off when the
// Microsoft C# extension is present), resolves the server (local override or download), starts the
// LSP client, performs the Roslyn handshake, and drives the shared state. Owns restart/dispose.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { detectRid } from "./rid.js";
import {
  createLanguageClient,
  performHandshake,
  registerRoslynProtocol,
  registerServerCommands,
} from "./roslynClient.js";
import {
  clearServerCache,
  ensureServerDownloaded,
  FeedUnreachableError,
  pruneServerCache,
  ResolvedServer,
} from "./roslynDownloader.js";
import { decideRazor, ROSLYN_LS_VERSION } from "./roslynPackage.js";
import { localServerKind, RazorLaunch } from "./roslynServer.js";
import { HtmlDocumentManager } from "./razor/htmlDocumentManager.js";
import { registerRazorEndpoints } from "./razor/razorEndpoints.js";
import { ServerStateStore } from "./serverState.js";

/**
 * Outcome of resolving Razor cohosting for a start: off (disabled via setting), unavailable (the
 * resolved server is too old to route Razor to the cohost handlers, or the package is missing the
 * cohost files), or loaded (the bundled cohost files are ready to launch). Nothing is downloaded
 * separately — the Razor service ships inside the server package.
 */
type RazorResolution =
  | { kind: "off" }
  | { kind: "unavailable"; detail: string }
  | { kind: "loaded"; launch: RazorLaunch; version: string };

const MS_EXTENSION_ID = "ms-dotnettools.csharp";
const CONTEXT_RUNNING = "csharpSolutionExplorer.languageServer.running";
const MS_CONFLICT_NOTIFIED_KEY = "languageServer.msConflictNotified";

export class LanguageServerController {
  private client: LanguageClient | undefined;
  private starting: Promise<void> | undefined;
  /** The projected-HTML store for Razor cohosting; created once, outlives individual clients. */
  private razorManager: HtmlDocumentManager | undefined;
  /** Per-client Razor cohost handlers; disposed when the client stops. */
  private razorEndpoints: vscode.Disposable | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ServerStateStore,
    private readonly output: vscode.OutputChannel,
  ) {
    // Global commands the server's CodeLens/completions invoke — registered once for the extension's life.
    this.context.subscriptions.push(registerServerCommands());
  }

  /** Starts (or, if already starting, joins the in-flight start). */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  async restart(): Promise<void> {
    this.state.update({ phase: "restarting", activity: "Restarting…" });
    await this.start();
  }

  /**
   * Stops the server, deletes the whole download cache, then restarts — which re-downloads the
   * current version fresh (or lands in the disabled/msExtConflict state if the server is off). A
   * "reset" for a corrupted download or to force a clean re-provision.
   */
  async clearCache(): Promise<void> {
    await this.stopClient();
    this.state.update({ phase: "restarting", activity: "Clearing server cache…" });
    try {
      await clearServerCache(this.context.globalStorageUri);
      this.output.appendLine("[C# Language Server] Cleared the server cache.");
    } catch (err) {
      this.output.appendLine(`[C# Language Server] Failed to clear the server cache: ${errMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not clear the C# language server cache: ${errMessage(err)}`);
    }
    await this.restart();
  }

  private async doStart(): Promise<void> {
    await this.stopClient();
    const config = vscode.workspace.getConfiguration("csharpSolutionExplorer.languageServer");

    if (!config.get<boolean>("enabled", true)) {
      this.state.set({ phase: "disabled", detail: "Disabled via settings." });
      await this.setRunningContext(false);
      return;
    }

    if (vscode.extensions.getExtension(MS_EXTENSION_ID)) {
      this.state.set({
        phase: "msExtConflict",
        detail:
          "The Microsoft C# extension is installed; the bundled server stays off to avoid running two language servers.",
      });
      await this.setRunningContext(false);
      await this.notifyMsConflictOnce();
      return;
    }

    const rid = detectRid();
    if (!rid) {
      this.state.set({
        phase: "failed",
        detail: `Unsupported platform/architecture: ${process.platform}/${process.arch}.`,
      });
      await this.setRunningContext(false);
      return;
    }

    const version = config.get<string>("version")?.trim() || ROSLYN_LS_VERSION;
    const logLevel = config.get<string>("logLevel", "Information");
    const serverPathOverride = config.get<string>("serverPath")?.trim();

    try {
      let server: ResolvedServer;
      if (serverPathOverride) {
        server = {
          rid,
          version,
          dir: "",
          entryPath: serverPathOverride,
          kind: localServerKind(serverPathOverride),
        };
      } else {
        this.state.set({ phase: "downloading", rid, version, activity: "Downloading server…" });
        server = await ensureServerDownloaded(this.context.globalStorageUri, rid, version);
        // Reclaim disk from superseded versions; fire-and-forget so it never delays the start.
        void this.pruneOldVersions(version);
      }

      const logDir = this.context.logUri.fsPath;
      await fs.mkdir(logDir, { recursive: true });

      const razor = this.resolveRazor(config, server);

      this.state.set({ phase: "starting", rid, version, activity: "Starting server…" });
      const razorLaunch = razor.kind === "loaded" ? razor.launch : undefined;
      const { client, razorLoaded } = await this.startClient(server, logLevel, logDir, razorLaunch);

      registerRoslynProtocol(client, this.state);
      this.applyRazorState(razor, razorLoaded, client);
      this.state.update({ phase: "running", activity: "Initializing projects…" });
      await this.setRunningContext(true);
      await performHandshake(client, this.state);
    } catch (err) {
      const detail = err instanceof FeedUnreachableError ? err.message : errMessage(err);
      this.state.set({ phase: "failed", rid, version, detail });
      await this.setRunningContext(false);
      void vscode.window.showErrorMessage(`C# language server failed to start: ${detail}`);
    }
  }

  /**
   * Resolves Razor cohosting for this start. The Razor service ships *inside* the server package, so
   * there is nothing extra to download: when Razor is enabled and the resolved server is new enough to
   * route Razor to the cohost handlers, we point the launch at the bundled files (next to the server
   * binary). An older server (via a `serverPath`/`version` override) or a package missing those files
   * is not fatal — Razor stays on Stufe-1 highlighting and C# runs normally, avoiding the request
   * errors an incompatible server would otherwise raise.
   */
  private resolveRazor(config: vscode.WorkspaceConfiguration, server: ResolvedServer): RazorResolution {
    const enabled = config.get<boolean>("razor.enabled", true);
    const decision = decideRazor(enabled, server.version, path.dirname(server.entryPath), existsSync);
    switch (decision.kind) {
      case "off":
        return { kind: "off" };
      case "unavailable":
        return { kind: "unavailable", detail: decision.detail };
      case "loaded":
        return {
          kind: "loaded",
          version: decision.version,
          launch: { csharpDesignTimePath: decision.paths.csharpDesignTimePath },
        };
    }
  }

  /**
   * Starts the client, first with Razor cohosting enabled. If the server fails to start that way (e.g.
   * it can't wire up the cohost service), retries once C#-only so a Razor problem never takes the C#
   * session down.
   */
  private async startClient(
    server: ResolvedServer,
    logLevel: string,
    logDir: string,
    razor: RazorLaunch | undefined,
  ): Promise<{ client: LanguageClient; razorLoaded: boolean }> {
    if (razor) {
      try {
        const client = await this.startClientWithFallback(server, logLevel, logDir, razor);
        return { client, razorLoaded: true };
      } catch (err) {
        this.output.appendLine(
          `[C# Language Server] Server failed to start with Razor cohosting (${errMessage(err)}); retrying C#-only.`,
        );
        await this.stopClient();
      }
    }
    const client = await this.startClientWithFallback(server, logLevel, logDir, undefined);
    return { client, razorLoaded: false };
  }

  private async startClientWithFallback(
    server: ResolvedServer,
    logLevel: string,
    logDir: string,
    razor: RazorLaunch | undefined,
  ): Promise<LanguageClient> {
    try {
      return await this.launchClient(server, logLevel, logDir, razor);
    } catch (primaryErr) {
      const fallback = dllFallback(server);
      if (!fallback) {
        throw primaryErr;
      }
      this.output.appendLine(
        `[C# Language Server] Native launch failed (${errMessage(primaryErr)}); retrying via 'dotnet exec'.`,
      );
      return this.launchClient(fallback, logLevel, logDir, razor);
    }
  }

  private async launchClient(
    server: ResolvedServer,
    logLevel: string,
    logDir: string,
    razor: RazorLaunch | undefined,
  ): Promise<LanguageClient> {
    const client = createLanguageClient(server, logLevel, logDir, this.output, razor);
    this.client = client;
    await client.start();
    return client;
  }

  /** Registers the Razor cohost endpoints (on success) and reflects the outcome in the status. */
  private applyRazorState(razor: RazorResolution, razorLoaded: boolean, client: LanguageClient): void {
    if (razorLoaded && razor.kind === "loaded") {
      this.razorManager ??= this.createRazorManager();
      this.razorEndpoints = registerRazorEndpoints(client, this.razorManager, (m) => this.output.appendLine(m));
      this.state.update({ razor: { loaded: true, version: razor.version } });
    } else if (razor.kind === "loaded") {
      // Cohost files were ready, but the server failed to start with them: fall back to highlighting-only.
      this.state.update({
        razor: {
          loaded: false,
          detail: "Razor cohosting could not be enabled with this server build; using highlighting only.",
        },
      });
    } else if (razor.kind === "unavailable") {
      // The server is too old to route Razor to the cohost handlers, or the package is missing the files.
      this.state.update({ razor: { loaded: false, detail: razor.detail } });
    } else {
      this.state.update({ razor: undefined });
    }
  }

  /** Best-effort removal of superseded cached server versions; logs what it removed, never throws. */
  private async pruneOldVersions(keepVersion: string): Promise<void> {
    try {
      const removed = await pruneServerCache(this.context.globalStorageUri, keepVersion);
      if (removed.length > 0) {
        this.output.appendLine(`[C# Language Server] Pruned old cached server version(s): ${removed.join(", ")}.`);
      }
    } catch (err) {
      this.output.appendLine(`[C# Language Server] Failed to prune old server versions: ${errMessage(err)}`);
    }
  }

  private createRazorManager(): HtmlDocumentManager {
    const manager = new HtmlDocumentManager(process.platform === "linux", (m) => this.output.appendLine(m));
    this.context.subscriptions.push(manager.register());
    return manager;
  }

  private async stopClient(): Promise<void> {
    this.razorEndpoints?.dispose();
    this.razorEndpoints = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.stop();
      } catch {
        // A server that already exited can throw on stop; nothing to recover.
      }
    }
  }

  private async setRunningContext(running: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", CONTEXT_RUNNING, running);
  }

  private async notifyMsConflictOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(MS_CONFLICT_NOTIFIED_KEY)) {
      return;
    }
    await this.context.globalState.update(MS_CONFLICT_NOTIFIED_KEY, true);
    void vscode.window.showInformationMessage(
      "C# Solution Explorer detected the Microsoft C# extension, so its bundled language server " +
        "stays off to avoid conflicts. Disable the Microsoft C# extension to use the bundled server.",
    );
  }

  /** Shows the language server's output channel. */
  showLogs(): void {
    this.output.show(true);
  }

  async dispose(): Promise<void> {
    await this.stopClient();
    await this.setRunningContext(false);
    this.output.dispose();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** For a downloaded native apphost, the sibling DLL launched via `dotnet exec`, if it exists. */
function dllFallback(server: ResolvedServer): ResolvedServer | undefined {
  if (server.kind !== "exe" || !server.dir) {
    return undefined;
  }
  const dll = path.join(server.dir, "Microsoft.CodeAnalysis.LanguageServer.dll");
  return existsSync(dll) ? { ...server, entryPath: dll, kind: "dll" } : undefined;
}
